export interface LLMMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
    toolCallId?: string;
    toolCalls?: LLMToolCall[];
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
    id: string;
    name: string;
    argumentsText: string;
}

export interface LLMJsonSchemaResponseFormat {
    type: "json_schema";
    json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
    };
}

export interface LLMJsonObjectResponseFormat {
    type: "json_object";
}

export type LLMResponseFormat = LLMJsonSchemaResponseFormat | LLMJsonObjectResponseFormat;

export interface LLMChatOptions {
    temperature?: number;
    max_tokens?: number;
    tools?: LLMToolDefinition[];
    toolChoice?: "none" | "auto";
    reasoningEffort?: ReasoningEffort;
    responseFormat?: LLMResponseFormat;
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
