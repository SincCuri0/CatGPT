import Groq from "groq-sdk";
import { LLMChatOptions, LLMClient, LLMMessage, LLMResponse } from "../types";
import { LLMProvider, ProviderConfig } from "../providerTypes";

const GROQ_MODELS = [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", description: "Best quality" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", description: "Fast & light" },
    { id: "llama-guard-3-8b", label: "Llama Guard 3", description: "Safety-focused" },
    { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B", description: "32K context" },
    { id: "gemma2-9b-it", label: "Gemma 2 9B", description: "Google model on Groq" },
];

export class GroqClient implements LLMClient {
    private client: Groq;
    private model: string;

    constructor(apiKey: string, model: string = "llama-3.3-70b-versatile") {
        if (!apiKey) throw new Error("API Key is required for GroqClient");
        this.client = new Groq({ apiKey, dangerouslyAllowBrowser: true });
        this.model = model;
    }

    async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
        try {
            const completion = await this.client.chat.completions.create({
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
            });

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
            console.error("Groq API Error:", error);
            throw error;
        }
    }
}

export class GroqProvider extends LLMProvider {
    get config(): ProviderConfig {
        return {
            id: "groq",
            name: "Groq",
            description: "Fastest inference",
            defaultModel: "llama-3.3-70b-versatile",
            models: GROQ_MODELS,
            requiresApiKey: true,
            apiKeyLink: "https://console.groq.com/keys",
        };
    }

    createClient(apiKey: string, model?: string): LLMClient {
        return new GroqClient(apiKey, model || this.config.defaultModel);
    }
}
