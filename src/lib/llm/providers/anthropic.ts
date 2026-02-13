import Anthropic from "@anthropic-ai/sdk";
import { LLMChatOptions, LLMClient, LLMMessage, LLMResponse } from "../types";
import { LLMProvider, ProviderConfig } from "../providerTypes";
import { supportsAnthropicThinking } from "../modelCatalog";

const ANTHROPIC_MODELS = [
    { id: "claude-3-opus-20240229", label: "Claude 3 Opus", description: "Most powerful" },
    { id: "claude-3-sonnet-20240229", label: "Claude 3 Sonnet", description: "Balanced" },
    { id: "claude-3-haiku-20240307", label: "Claude 3 Haiku", description: "Fastest" },
];

const THINKING_BUDGET_BY_EFFORT = {
    low: 512,
    medium: 1024,
    high: 2048,
} as const;

class AnthropicClient implements LLMClient {
    public readonly supportsNativeToolCalling = true;
    private client: Anthropic;
    private model: string;

    constructor(apiKey: string, model: string = "claude-3-opus-20240229") {
        this.client = new Anthropic({ apiKey });
        this.model = model;
    }

    async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
        try {
            const systemMessage = messages.find(m => m.role === "system");
            const userAssistantMessages = messages.filter(m => m.role !== "system").map(m => ({
                role: m.role as "user" | "assistant",
                content: m.content,
            }));

            const requestPayload: Anthropic.MessageCreateParamsNonStreaming = {
                model: this.model,
                system: systemMessage?.content,
                messages: userAssistantMessages,
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.max_tokens ?? 4096,
            };

            if (options?.tools && options.tools.length > 0) {
                requestPayload.tools = options.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema,
                }));

                requestPayload.tool_choice = options.toolChoice === "none"
                    ? { type: "none" }
                    : { type: "auto", disable_parallel_tool_use: true };
            }

            if (options?.reasoningEffort && options.reasoningEffort !== "none" && supportsAnthropicThinking(this.model)) {
                requestPayload.thinking = {
                    type: "enabled",
                    budget_tokens: THINKING_BUDGET_BY_EFFORT[options.reasoningEffort],
                };
            }

            const response = await this.client.messages.create(requestPayload);

            const content = response.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n")
                .trim();

            const toolCalls = response.content
                .filter((block) => block.type === "tool_use")
                .map((block) => ({
                    id: block.id,
                    name: block.name,
                    argumentsText: JSON.stringify(block.input ?? {}),
                }));

            return {
                content,
                toolCalls,
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
