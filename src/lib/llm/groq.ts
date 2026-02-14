import Groq from "groq-sdk";
import { LLMChatOptions, LLMClient, LLMMessage, LLMResponse } from "./types";

function toGroqMessages(messages: LLMMessage[]): Record<string, unknown>[] {
    return messages.map((message) => {
        if (message.role === "tool") {
            return {
                role: "tool",
                content: message.content,
                tool_call_id: message.toolCallId || "unknown_tool_call",
            };
        }

        if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
            return {
                role: "assistant",
                content: message.content || null,
                tool_calls: message.toolCalls.map((toolCall) => ({
                    id: toolCall.id,
                    type: "function",
                    function: {
                        name: toolCall.name,
                        arguments: toolCall.argumentsText,
                    },
                })),
            };
        }

        return {
            role: message.role,
            content: message.content,
        };
    });
}

export class GroqClient implements LLMClient {
    private client: Groq;
    private model: string;

    constructor(apiKey: string, model: string = "llama-3.3-70b-versatile") {
        if (!apiKey) throw new Error("API Key is required for GroqClient");
        this.client = new Groq({ apiKey, dangerouslyAllowBrowser: true }); // We allow browser because keys are local-only
        this.model = model;
    }

    async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
        try {
            const completion = await this.client.chat.completions.create({
                messages: toGroqMessages(messages) as unknown as Parameters<typeof this.client.chat.completions.create>[0]["messages"],
                model: this.model,
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.max_tokens ?? 4096,
            });

            const toolCalls = completion.choices[0]?.message?.tool_calls
                ?.filter((toolCall) => toolCall.type === "function")
                .map((toolCall, index) => ({
                    id: toolCall.id || `tool_call_${index + 1}`,
                    name: toolCall.function.name,
                    argumentsText: toolCall.function.arguments || "{}",
                }));

            return {
                content: completion.choices[0]?.message?.content || "",
                toolCalls,
                usage: {
                    total_tokens: completion.usage?.total_tokens || 0,
                },
            };
        } catch (error) {
            console.error("Groq API Error:", error);
            throw error;
        }
    }
}

export function createLLMClient(apiKey: string): LLMClient {
    // Extensible for other providers later
    return new GroqClient(apiKey);
}
