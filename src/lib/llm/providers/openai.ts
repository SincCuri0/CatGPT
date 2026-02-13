import OpenAI from "openai";
import { LLMChatOptions, LLMClient, LLMMessage, LLMResponse } from "../types";
import { LLMProvider, ProviderConfig } from "../providerTypes";
import { supportsOpenAIReasoningEffort } from "../modelCatalog";

const OPENAI_MODELS = [
    { id: "gpt-4o", label: "GPT-4o", description: "Most capable model" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo", description: "Fast & accurate" },
    { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", description: "Fast & cheap" },
];

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
                messages: messages.map(m => ({ role: m.role, content: m.content })),
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

            const completion = await this.client.chat.completions.create(requestPayload);

            const message = completion.choices[0]?.message;
            const toolCalls = message?.tool_calls
                ?.filter((toolCall) => toolCall.type === "function")
                .map((toolCall) => ({
                    id: toolCall.id,
                    name: toolCall.function.name,
                    argumentsText: toolCall.function.arguments,
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
