import "dotenv/config";
import express from "express";
import { createAttendantAgent } from "./agents/AttendantAgent";
import { createJudgeAgent } from "./agents/JudgeAgent";
import { OllamaLlmProvider } from "./providers/LlmProvider/implementations/OllamaLlmProvider";
import { Message } from "./providers/LlmProvider/interfaces/ILlmProvider";
import { QdrantProductRepository } from "./repositories/productsRepository/implementations/QdrantProductsRepository";
import { QdrantCompanyRepository } from "./repositories/companyRepository/implementations/QdrantCompanyRepository";
import { OllamaEmbeddingProvider } from "./providers/EmbeddingProvider/implementations/OllamaEmbeddingProvider";
import { LangSmithAgentTracingProvider } from "./providers/AgentTracingProvider/implementations/LangSmithAgentTracingProvider";
import { seedProducts } from "./seeds/seedProducts";
import { seedCompany } from "./seeds/seedCompany";

const app = express();
app.use(express.json());

const provider = new OllamaLlmProvider();
const tracer = new LangSmithAgentTracingProvider();
const productsRepository = QdrantProductRepository.getInstance();
const companyRepository = QdrantCompanyRepository.getInstance();
const embedding = new OllamaEmbeddingProvider();

Promise.all([
  productsRepository.ensureCollection(),
  companyRepository.ensureCollection(),
]).then(() => {
  Promise.all([
    seedProducts(productsRepository, embedding),
    seedCompany(companyRepository, embedding),
  ]);
});

const AttendantAgent = createAttendantAgent(
  productsRepository,
  companyRepository,
  embedding,
);

const JudgeAgent = createJudgeAgent();

app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const emit = (data: object) => res.write(`${JSON.stringify(data)}\n\n`);
  let requestRunId = "";
  try {
    const { messages }: { messages: Message[] } = req.body;

    ({ runId: requestRunId } = await tracer.startRun({
      name: "ChatRequest",
      runType: "chain",
      inputs: { messages },
      tags: ["chat"],
    }));

    const allMessages: Message[] = [
      { role: "system", content: AttendantAgent.getInstructions() },
      ...messages,
    ];

    let finalMessage = "";

    let MAX_ATTEMPTS = 2;
    let attempt = 0;
    let judgment: {
      score: number;
      approved: boolean;
      reason: string;
    } | null = null;

    const userQuestion = messages.at(-1)?.content ?? "";

    while (true) {
      if (attempt >= MAX_ATTEMPTS) {
        allMessages.push({
          role: "system",
          content: `Você não conseguiu formular uma resposta adequada para a pergunta: "${userQuestion}" após ${MAX_ATTEMPTS} tentativas.
        Por favor, responda a pergunta dizendo que não consegue ajudar com isso no momento, sem tentar responder novamente. e sem chamar nenhuma Tool.`,
        });

        emit({ type: "thinking", status: "Pensando..." });
        const { runId: fallbackRunId } = await tracer.startChildRun({
          parentRunId: requestRunId,
          name: "AttendantAgent/fallback",
          runType: "llm",
          inputs: { messages: allMessages },
        });

        const { message: fallbackResponse, usage: fallbackUsage } =
          await provider.chat({
            agent: AttendantAgent,
            messages: allMessages,
          });

        finalMessage = fallbackResponse.content;

        await tracer.endChildRun({
          childRunId: fallbackRunId,
          outputs: { message: finalMessage },
          extra: { usage: fallbackUsage },
        });
        break;
      }

      if (judgment && !judgment.approved) {
        emit({ type: "retry", status: "Refinando resposta..." });
        allMessages.push({
          role: "system",
          content: `Sua resposta anterior: "${finalMessage}"
        para a pergunta: "${userQuestion}"
        foi reprovada pelo avaliador.
        Motivo: "${judgment?.reason ?? "resposta fora das regras"}"
        Por favor, responda novamente à pergunta original seguindo as regras.`,
        });
      } else {
        emit({ type: "thinking", status: "Pensando..." });
      }

      const { runId: attendantRunId } = await tracer.startChildRun({
        parentRunId: requestRunId,
        name: `AttendantAgent/attempt-${attempt + 1}`,
        runType: "llm",
        inputs: { messages: allMessages },
      });

      let { message: response, usage: attendantUsage } = await provider.chat({
        agent: AttendantAgent,
        messages: allMessages,
      });

      while (response.tool_calls && response.tool_calls.length > 0) {
        allMessages.push(response);

        await Promise.all(
          response.tool_calls.map(async (toolCall) => {
            const toolStatusLabels: Record<string, string> = {
              findCompanyProducts: "Buscando produtos...",
              findCompanyInfo: "Buscando informações...",
            };
            emit({
              type: "tool_call",
              status:
                toolStatusLabels[toolCall.function.name] ?? "Buscando dados...",
            });

            const tool = AttendantAgent.tools.find(
              (t) => t.name === toolCall.function.name,
            );
            const args =
              typeof toolCall.function.arguments === "string"
                ? JSON.parse(toolCall.function.arguments)
                : toolCall.function.arguments;

            const { runId: toolRunId } = await tracer.startChildRun({
              parentRunId: requestRunId,
              name: `Tool/${toolCall.function.name}`,
              runType: "tool",
              inputs: { args },
            });

            const result = tool ? await tool.execute(args) : null;

            await tracer.endChildRun({
              childRunId: toolRunId,
              outputs: { result },
            });

            allMessages.push({
              role: "tool",
              content: JSON.stringify(result),
            });
          }),
        );

        emit({ type: "thinking", status: "Pensando..." });
        const { message: nextResponse, usage: nextUsage } = await provider.chat(
          {
            agent: AttendantAgent,
            messages: allMessages,
          },
        );
        response = nextResponse;
        attendantUsage = {
          prompt_tokens: attendantUsage.prompt_tokens + nextUsage.prompt_tokens,
          completion_tokens:
            attendantUsage.completion_tokens + nextUsage.completion_tokens,
          total_tokens: attendantUsage.total_tokens + nextUsage.total_tokens,
        };
      }

      const attendantAnswer = response.content;
      finalMessage = attendantAnswer;

      await tracer.endChildRun({
        childRunId: attendantRunId,
        outputs: { message: attendantAnswer },
        extra: { usage: attendantUsage },
      });

      emit({ type: "judging", status: "Verificando resposta..." });
      const judgeMessages: Message[] = [
        { role: "system", content: JudgeAgent.getInstructions() },
        {
          role: "user",
          content: `Pergunta do cliente: ${userQuestion}\n\nResposta do atendente: ${attendantAnswer}`,
        },
      ];

      const { runId: judgeRunId } = await tracer.startChildRun({
        parentRunId: requestRunId,
        name: "JudgeAgent",
        runType: "llm",
        inputs: { userQuestion, attendantAnswer },
      });

      const { message: judgeResponse, usage: judgeUsage } = await provider.chat(
        {
          agent: JudgeAgent,
          messages: judgeMessages,
        },
      );

      try {
        judgment = JSON.parse(judgeResponse.content ?? "{}");
      } catch {
        judgment = null;
      }

      await tracer.endChildRun({
        childRunId: judgeRunId,
        outputs: { judgment },
        extra: { usage: judgeUsage },
      });

      if (judgment?.approved) {
        break;
      }

      attempt = attempt + 1;
    }

    await tracer.endRun({
      runId: requestRunId,
      outputs: { message: finalMessage },
    });

    emit({ type: "done", message: finalMessage });
  } catch (error) {
    if (requestRunId) {
      await tracer.endRun({
        runId: requestRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    emit({
      type: "done",
      message:
        "Ops tive um problema ao processar sua solicitação. Por favor, tente novamente mais tarde.",
    });
  }
  res.end();
});

const PORT = process.env["PORT"] ?? 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
