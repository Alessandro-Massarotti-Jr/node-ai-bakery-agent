import axios, { AxiosInstance } from "axios";
import { Agent } from "../../../agents";
import { ILlmProvider, Message } from "../interfaces/ILlmProvider";
import { Parameter, Tool } from "../../../tools";

export class OllamaLlmProvider implements ILlmProvider {
  private requester: AxiosInstance;

  constructor() {
    const baseURL = process.env.OLLAMA_URL as string;
    this.requester = axios.create({ baseURL });
  }

  async chat(data: { agent: Agent; messages: Message[] }): Promise<Message> {
    try {
      const { agent, messages } = data;

      const response = await this.requester.post("/chat", {
        model: agent.model,
        messages: messages,
        tools: this.formatTools(agent.tools),
        stream: false,
      });

      return response.data.message as any;
    } catch (error) {
      console.error(axios.isAxiosError(error) ? error.response?.data : error);
      throw error;
    }
  }

  private formatTools(tools: Tool[]) {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            tool.parameters.map((p) => [p.name, this.formatParameter(p)]),
          ),
          required: this.getRequiredItems(tool.parameters),
        },
      },
    }));
  }

  private formatParameter(parameter: Parameter): any {
    switch (parameter.type) {
      case "array":
        return {
          type: parameter.type,
          description: parameter.description,
          items: this.formatParameter(parameter.items),
        };
      case "object":
        return {
          type: parameter.type,
          description: parameter.description,
          properties: Object.fromEntries(
            parameter.properties.map((p) => [p.name, this.formatParameter(p)]),
          ),
          required: this.getRequiredItems(parameter.properties),
        };
      default:
        return {
          type: parameter.type,
          description: parameter.description,
        };
    }
  }

  private getRequiredItems(parameters: Parameter[]): string[] {
    return parameters
      .filter((parameter) => parameter.required)
      .map((parameter) => parameter.name);
  }
}
