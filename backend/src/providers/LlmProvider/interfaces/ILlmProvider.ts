import { Agent } from "../../../agents";

export type Message = {
  role: string;
  content: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
};

export interface ILlmProvider {
  chat(data: {
    agent: Agent;
    messages: Message[];
  }): Promise<Message>;
}
