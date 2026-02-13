export interface LLMMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface LLMToolDefinition {
    id: string;
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
}

export interface LLMToolCall {
    id?: string;
    name: string;
    argumentsText: string;
}

export interface LLMChatOptions {
    temperature?: number;
    max_tokens?: number;
    tools?: LLMToolDefinition[];
    toolChoice?: "none" | "auto";
    reasoningEffort?: ReasoningEffort;
}

export interface LLMResponse {
    content: string;
    toolCalls?: LLMToolCall[];
    usage?: {
        total_tokens: number;
    };
}

export interface LLMClient {
    supportsNativeToolCalling?: boolean;
    chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse>;
}
