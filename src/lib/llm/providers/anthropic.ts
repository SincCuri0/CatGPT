import Anthropic from "@anthropic-ai/sdk";
import { LLMChatOptions, LLMClient, LLMMessage, LLMResponse } from "../types";
import { LLMProvider, ProviderConfig } from "../providerTypes";

const ANTHROPIC_MODELS = [
    { id: "claude-3-opus-20240229", label: "Claude 3 Opus", description: "Most powerful" },
    { id: "claude-3-sonnet-20240229", label: "Claude 3 Sonnet", description: "Balanced" },
    { id: "claude-3-haiku-20240307", label: "Claude 3 Haiku", description: "Fastest" },
];

class AnthropicClient implements LLMClient {
    private client: Anthropic;
    private model: string;

    constructor(apiKey: string, model: string = "claude-3-opus-20240229") {
        this.client = new Anthropic({ apiKey });
        this.model = model;
    }

    async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
        try {
            // Convert messages to Anthropic format
            const systemMessage = messages.find(m => m.role === "system");
            const userAssistantMessages = messages.filter(m => m.role !== "system").map(m => ({
                role: m.role as "user" | "assistant",
                content: m.content
            }));

            const response = await this.client.messages.create({
                model: this.model,
                system: systemMessage?.content,
                messages: userAssistantMessages,
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.max_tokens ?? 4096,
            });

            const content = response.content[0].type === 'text' ? response.content[0].text : "";

            return {
                content,
                usage: {
                    total_tokens: (response.usage.input_tokens + response.usage.output_tokens) || 0,
                },
            };
        } catch (error) {
            console.error("Anthropic API Error:", error);
            throw error;
        }
    }
}

export class AnthropicProvider extends LLMProvider {
    get config(): ProviderConfig {
        return {
            id: "anthropic",
            name: "Anthropic",
            description: "Creators of Claude",
            defaultModel: "claude-3-opus-20240229",
            models: ANTHROPIC_MODELS,
            requiresApiKey: true,
            apiKeyLink: "https://console.anthropic.com/settings/keys",
        };
    }

    createClient(apiKey: string, model?: string): LLMClient {
        return new AnthropicClient(apiKey, model || this.config.defaultModel);
    }
}
