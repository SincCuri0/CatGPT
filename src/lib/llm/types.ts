export interface LLMMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface LLMResponse {
    content: string;
    usage?: {
        total_tokens: number;
    };
}

export interface LLMClient {
    chat(messages: LLMMessage[], options?: { temperature?: number; max_tokens?: number }): Promise<LLMResponse>;
}
