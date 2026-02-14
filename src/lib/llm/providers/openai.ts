import OpenAI from "openai";
import { LLMChatOptions, LLMClient, LLMMessage, LLMResponse } from "../types";
import { LLMProvider, ProviderConfig } from "../providerTypes";
import { supportsOpenAIReasoningEffort } from "../modelCatalog";

const OPENAI_MODELS = [
    { id: "gpt-4o", label: "GPT-4o", description: "Most capable model" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo", description: "Fast & accurate" },
    { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", description: "Fast & cheap" },
];

function safeParseToolArgs(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {};
    try {
        const parsed = JSON.parse(raw);
        return (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function toOpenAIMessages(messages: LLMMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map((message) => {
        if (message.role === "tool") {
            return {
                role: "tool",
                content: message.content,
                tool_call_id: message.toolCallId || "unknown_tool_call",
            } satisfies OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
        }

        if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
            return {
                role: "assistant",
                content: message.content || null,
                tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: {
                        name: call.name,
                        arguments: call.argumentsText,
                    },
                })),
            } satisfies OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
        }

        if (message.role === "system") {
            return {
                role: "system",
                content: message.content,
            } satisfies OpenAI.Chat.Completions.ChatCompletionSystemMessageParam;
        }

        return {
            role: message.role,
            content: message.content,
        } satisfies OpenAI.Chat.Completions.ChatCompletionUserMessageParam | OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    });
}

class OpenAIClient implements LLMClient {
    public readonly supportsNativeToolCalling = true;
    private client: OpenAI;
    private model: string;

    constructor(apiKey: string, model: string = "gpt-4o") {
        this.client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
        this.model = model;
    }

    async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
        try {
            const requestPayload: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
                messages: toOpenAIMessages(messages),
                model: this.model,
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.max_tokens ?? 4096,
                tools: options?.tools?.map((tool) => ({
                    type: "function",
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                    },
                })),
                tool_choice: options?.toolChoice === "none" ? "none" : "auto",
            };

            if (options?.reasoningEffort && options.reasoningEffort !== "none" && supportsOpenAIReasoningEffort(this.model)) {
                requestPayload.reasoning_effort = options.reasoningEffort;
            }

            if (options?.responseFormat) {
                (requestPayload as unknown as { response_format?: unknown }).response_format = options.responseFormat.type === "json_schema"
                    ? {
                        type: "json_schema",
                        json_schema: {
                            name: options.responseFormat.json_schema.name,
                            schema: options.responseFormat.json_schema.schema,
                            strict: options.responseFormat.json_schema.strict === true,
                        },
                    }
                    : { type: "json_object" };
            }

            const completion = await this.client.chat.completions.create(requestPayload);

            const message = completion.choices[0]?.message;
            const toolCalls = message?.tool_calls
                ?.filter((toolCall) => toolCall.type === "function")
                .map((toolCall, index) => ({
                    id: toolCall.id || `tool_call_${index + 1}`,
                    name: toolCall.function.name,
                    argumentsText: JSON.stringify(safeParseToolArgs(toolCall.function.arguments || "{}")),
                }));

            return {
                content: message?.content || "",
                toolCalls,
                usage: {
                    total_tokens: completion.usage?.total_tokens || 0,
                },
            };
        } catch (error) {
            console.error("OpenAI API Error:", error);
            throw error;
        }
    }
}

export class OpenAIProvider extends LLMProvider {
    get config(): ProviderConfig {
        return {
            id: "openai",
            name: "OpenAI",
            description: "Creators of GPT-4",
            defaultModel: "gpt-4o",
            models: OPENAI_MODELS,
            requiresApiKey: true,
            apiKeyLink: "https://platform.openai.com/api-keys",
        };
    }

    createClient(apiKey: string, model?: string): LLMClient {
        return new OpenAIClient(apiKey, model || this.config.defaultModel);
    }
}
