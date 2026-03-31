import "dotenv/config";
import express from "express";
import { createAttendantAgent } from "./agents/AttendantAgent";
import { createJudgeAgent } from "./agents/JudgeAgent";
import { OllamaLlmProvider } from "./providers/LlmProvider/implementations/OllamaLlmProvider";
import { Message } from "./providers/LlmProvider/interfaces/ILlmProvider";
import { QdrantProductRepository } from "./repositories/productsRepository/implementations/QdrantProductsRepository";
import { QdrantCompanyRepository } from "./repositories/companyRepository/implementations/QdrantCompanyRepository";
import { OllamaEmbeddingProvider } from "./providers/EmbeddingProvider/implementations/OllamaEmbeddingProvider";
import { seedProducts } from "./seeds/seedProducts";
import { seedCompany } from "./seeds/seedCompany";

const app = express();
app.use(express.json());

const provider = new OllamaLlmProvider();
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
  const { messages }: { messages: Message[] } = req.body;

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

      const fallbackResponse = await provider.chat({
        agent: AttendantAgent,
        messages: allMessages,
      });

      finalMessage = fallbackResponse.content;
      break;
    }

    if (judgment && !judgment.approved) {
      allMessages.push({
        role: "system",
        content: `Sua resposta anterior: "${finalMessage}" 
        para a pergunta: "${userQuestion}" 
        foi reprovada pelo avaliador.
        Motivo: "${judgment?.reason ?? "resposta fora das regras"}"
        Por favor, responda novamente à pergunta original seguindo as regras.`,
      });
    }

    let response = await provider.chat({
      agent: AttendantAgent,
      messages: allMessages,
    });

    while (response.tool_calls && response.tool_calls.length > 0) {
      allMessages.push(response);

      await Promise.all(
        response.tool_calls.map(async (toolCall) => {
          const tool = AttendantAgent.tools.find(
            (t) => t.name === toolCall.function.name,
          );
          const result = tool
            ? await tool.execute(toolCall.function.arguments)
            : null;
          allMessages.push({
            role: "tool",
            content: JSON.stringify(result),
          });
        }),
      );

      response = await provider.chat({
        agent: AttendantAgent,
        messages: allMessages,
      });
    }

    const attendantAnswer = response.content ?? "";
    finalMessage = attendantAnswer;

    const judgeMessages: Message[] = [
      { role: "system", content: JudgeAgent.getInstructions() },
      {
        role: "user",
        content: `Pergunta do cliente: ${userQuestion}\n\nResposta do atendente: ${attendantAnswer}`,
      },
    ];

    const judgeResponse = await provider.chat({
      agent: JudgeAgent,
      messages: judgeMessages,
    });
    try {
      judgment = JSON.parse(judgeResponse.content ?? "{}");
    } catch {
      judgment = null;
    }
    if (judgment?.approved) {
      break;
    }

    attempt = attempt + 1;
  }

  res.json({ message: finalMessage });
});

const PORT = process.env["PORT"] ?? 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
