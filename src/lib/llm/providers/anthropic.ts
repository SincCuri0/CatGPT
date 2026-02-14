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

function toAnthropicPayload(messages: LLMMessage[]): {
    system?: string;
    messages: Anthropic.MessageCreateParamsNonStreaming["messages"];
} {
    const systemParts: string[] = [];
    const payloadMessages: Anthropic.MessageCreateParamsNonStreaming["messages"] = [];

    for (const message of messages) {
        if (message.role === "system") {
            if (message.content.trim().length > 0) {
                systemParts.push(message.content);
            }
            continue;
        }

        if (message.role === "user") {
            payloadMessages.push({
                role: "user",
                content: message.content,
            });
            continue;
        }

        if (message.role === "assistant") {
            if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
                const blocks: Anthropic.ContentBlockParam[] = [];
                if (message.content.trim().length > 0) {
                    blocks.push({
                        type: "text",
                        text: message.content,
                    });
                }

                for (const toolCall of message.toolCalls) {
                    blocks.push({
                        type: "tool_use",
                        id: toolCall.id,
                        name: toolCall.name,
                        input: safeParseToolArgs(toolCall.argumentsText),
                    });
                }

                payloadMessages.push({
                    role: "assistant",
                    content: blocks,
                });
                continue;
            }

            payloadMessages.push({
                role: "assistant",
                content: message.content,
            });
            continue;
        }

        payloadMessages.push({
            role: "user",
            content: [{
                type: "tool_result",
                tool_use_id: message.toolCallId || "unknown_tool_call",
                content: message.content,
            }],
        });
    }

    return {
        system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
        messages: payloadMessages,
    };
}

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
            const anthropicPayload = toAnthropicPayload(messages);

            const requestPayload: Anthropic.MessageCreateParamsNonStreaming = {
                model: this.model,
                system: anthropicPayload.system,
                messages: anthropicPayload.messages,
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
                .map((block, index) => ({
                    id: block.id || `tool_call_${index + 1}`,
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
