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

async function bootstrap() {
  await productsRepository.ensureCollection();
  await companyRepository.ensureCollection();

  await Promise.all([
    seedProducts(productsRepository, embedding),
    seedCompany(companyRepository, embedding),
  ]);

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

    let response = await provider.chat({
      agent: AttendantAgent,
      messages: allMessages,
    });

    while (response.tool_calls && response.tool_calls.length > 0) {
      allMessages.push(response);

      for (const toolCall of response.tool_calls) {
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
      }

      response = await provider.chat({
        agent: AttendantAgent,
        messages: allMessages,
      });
    }

    const userQuestion = messages.at(-1)?.content ?? "";
    const attendantAnswer = response.content ?? "";

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

    let finalMessage = attendantAnswer;
    try {
      const judgment = JSON.parse(judgeResponse.content ?? "{}");
      finalMessage = judgment.response ?? attendantAnswer;
    } catch {
      finalMessage = attendantAnswer;
    }

    res.json({ message: finalMessage });
  });

  const PORT = process.env["PORT"] ?? 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
