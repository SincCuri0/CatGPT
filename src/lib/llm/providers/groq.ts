import Groq from "groq-sdk";
import type { ChatCompletionCreateParamsNonStreaming } from "groq-sdk/resources/chat/completions";
import { LLMChatOptions, LLMClient, LLMMessage, LLMResponse } from "../types";
import { LLMProvider, ProviderConfig } from "../providerTypes";
import { supportsGroqReasoningEffort } from "../modelCatalog";

const GROQ_MODELS = [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", description: "Best quality" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", description: "Fast & light" },
    { id: "gemma2-9b-it", label: "Gemma 2 9B", description: "Google model on Groq" },
];

const GROQ_PREFERRED_CHAT_FALLBACK_MODELS = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "gemma2-9b-it",
];

const NON_CHAT_MODEL_HINT_TOKENS = [
    "whisper",
    "transcrib",
    "embedding",
    "moderation",
    "guard",
    "tts",
    "speech",
];

interface GroqErrorEnvelope {
    code?: unknown;
    failed_generation?: unknown;
}

interface GroqErrorLike {
    code?: unknown;
    message?: unknown;
    failed_generation?: unknown;
    error?: GroqErrorEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function safeJsonParse<T>(raw: string): T | null {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function escapeControlCharsInsideStrings(raw: string): string {
    let output = "";
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];

        if (inString) {
            if (escaped) {
                output += ch;
                escaped = false;
                continue;
            }

            if (ch === "\\") {
                output += ch;
                escaped = true;
                continue;
            }

            if (ch === "\"") {
                output += ch;
                inString = false;
                continue;
            }

            if (ch === "\n") {
                output += "\\n";
                continue;
            }
            if (ch === "\r") {
                output += "\\r";
                continue;
            }
            if (ch === "\t") {
                output += "\\t";
                continue;
            }

            output += ch;
            continue;
        }

        output += ch;
        if (ch === "\"") {
            inString = true;
        }
    }

    return output;
}

function extractFirstJsonObjectText(raw: string): string | null {
    const start = raw.indexOf("{");
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === "\"") {
                inString = false;
            }
            continue;
        }

        if (ch === "\"") {
            inString = true;
            continue;
        }

        if (ch === "{") {
            depth += 1;
            continue;
        }
        if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                return raw.slice(start, i + 1);
            }
        }
    }

    return null;
}

function safeJsonParseWithRecovery<T>(raw: string): T | null {
    const direct = safeJsonParse<T>(raw);
    if (direct !== null) return direct;

    const escaped = escapeControlCharsInsideStrings(raw);
    const escapedParsed = safeJsonParse<T>(escaped);
    if (escapedParsed !== null) return escapedParsed;

    const firstObject = extractFirstJsonObjectText(raw);
    if (!firstObject) return null;

    const firstDirect = safeJsonParse<T>(firstObject);
    if (firstDirect !== null) return firstDirect;

    const firstEscaped = safeJsonParse<T>(escapeControlCharsInsideStrings(firstObject));
    if (firstEscaped !== null) return firstEscaped;

    return null;
}

function normalizeArgumentsText(rawArguments: unknown): string {
    if (typeof rawArguments === "string") {
        const parsedDirect = safeJsonParseWithRecovery<unknown>(rawArguments);
        if (parsedDirect) {
            return JSON.stringify(parsedDirect);
        }

        const firstObject = extractFirstJsonObjectText(rawArguments);
        if (firstObject) {
            const parsedObject = safeJsonParseWithRecovery<unknown>(firstObject);
            if (parsedObject) {
                return JSON.stringify(parsedObject);
            }
        }

        return "{}";
    }

    if (rawArguments === undefined || rawArguments === null) {
        return "{}";
    }

    return JSON.stringify(rawArguments);
}

function parseToolCallObject(raw: unknown): { name: string; argumentsText: string } | null {
    if (!isRecord(raw)) return null;

    const nestedFunction = isRecord(raw.function) ? raw.function : null;
    const rawName = raw.name ?? raw.tool ?? raw.tool_name ?? raw.function;
    const nestedName = nestedFunction?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const resolvedName = name || (typeof nestedName === "string" ? nestedName.trim() : "");
    if (!resolvedName) return null;

    const rawArguments = raw.arguments
        ?? raw.args
        ?? raw.input
        ?? nestedFunction?.arguments
        ?? {};
    return {
        name: resolvedName,
        argumentsText: normalizeArgumentsText(rawArguments),
    };
}

function parseErrorDetailsFromUnknown(input: unknown): { code: string | null; failedGeneration: string | null } {
    if (!isRecord(input)) {
        return { code: null, failedGeneration: null };
    }

    const candidate = input as GroqErrorLike;
    const nested = isRecord(candidate.error) ? candidate.error : null;

    const code = typeof nested?.code === "string"
        ? nested.code
        : (typeof candidate.code === "string" ? candidate.code : null);

    const failedGeneration = typeof nested?.failed_generation === "string"
        ? nested.failed_generation
        : (typeof candidate.failed_generation === "string" ? candidate.failed_generation : null);

    return { code, failedGeneration };
}

function extractGroqErrorDetails(error: unknown): { code: string | null; failedGeneration: string | null } {
    const direct = parseErrorDetailsFromUnknown(error);
    if (direct.code || direct.failedGeneration) {
        return direct;
    }

    if (!isRecord(error)) {
        return { code: null, failedGeneration: null };
    }

    const message = typeof error.message === "string" ? error.message : "";
    if (!message) {
        return { code: null, failedGeneration: null };
    }

    const directFromMessage = safeJsonParse<unknown>(message) ?? (
        (() => {
            const firstObject = extractFirstJsonObjectText(message);
            return firstObject ? safeJsonParse<unknown>(firstObject) : null;
        })()
    );
    if (!directFromMessage) {
        return { code: null, failedGeneration: null };
    }

    const fromMessage = parseErrorDetailsFromUnknown(directFromMessage);
    return {
        code: fromMessage.code ?? direct.code,
        failedGeneration: fromMessage.failedGeneration ?? direct.failedGeneration,
    };
}

function parseFailedGenerationToolCall(failedGeneration: string): { name: string; argumentsText: string } | null {
    const wrapperMatch = failedGeneration.match(/<function=([a-zA-Z0-9_-]+)\s*([\s\S]*?)\s*<\/function>/i);
    if (wrapperMatch) {
        const toolName = wrapperMatch[1]?.trim();
        const wrappedArguments = wrapperMatch[2]?.trim();
        if (toolName) {
            return {
                name: toolName,
                argumentsText: normalizeArgumentsText(wrappedArguments),
            };
        }
    }

    const parsedDirect = safeJsonParseWithRecovery<unknown>(failedGeneration);
    if (parsedDirect) {
        const parsedToolCall = parseToolCallObject(parsedDirect);
        if (parsedToolCall) return parsedToolCall;

        if (isRecord(parsedDirect)) {
            const toolCalls = parsedDirect.tool_calls;
            if (Array.isArray(toolCalls)) {
                for (const call of toolCalls) {
                    const parsed = parseToolCallObject(call);
                    if (parsed) return parsed;
                }
            }
        }
    }

    const firstObject = extractFirstJsonObjectText(failedGeneration);
    if (firstObject) {
        const parsedObject = safeJsonParseWithRecovery<unknown>(firstObject);
        if (parsedObject) {
            const parsedToolCall = parseToolCallObject(parsedObject);
            if (parsedToolCall) return parsedToolCall;
        }
    }

    const rawNameMatch = failedGeneration.match(/"name"\s*:\s*"([^"]+)"/i);
    if (rawNameMatch?.[1]) {
        return {
            name: rawNameMatch[1].trim(),
            argumentsText: "{}",
        };
    }

    return null;
}

function parseFailedGenerationToolCallLegacy(failedGeneration: string): { name: string; argumentsText: string } | null {
    const match = failedGeneration.match(/<function=([a-zA-Z0-9_-]+)\s*({[\s\S]*?})\s*<\/function>/i);
    if (!match) return null;

    const toolName = match[1]?.trim();
    const rawArgs = match[2]?.trim();
    if (!toolName || !rawArgs) return null;

    try {
        const parsed = safeJsonParseWithRecovery<Record<string, unknown>>(rawArgs);
        if (!parsed) {
            return {
                name: toolName,
                argumentsText: "{}",
            };
        }
        return {
            name: toolName,
            argumentsText: JSON.stringify(parsed),
        };
    } catch {
        return {
            name: toolName,
            argumentsText: "{}",
        };
    }
}

function parseFailedGenerationToolCallCompat(failedGeneration: string): { name: string; argumentsText: string } | null {
    return parseFailedGenerationToolCall(failedGeneration)
        ?? parseFailedGenerationToolCallLegacy(failedGeneration);
}

function isLikelyChatModel(modelId: string): boolean {
    const normalized = modelId.trim().toLowerCase();
    if (!normalized) return false;
    return !NON_CHAT_MODEL_HINT_TOKENS.some((token) => normalized.includes(token));
}

function isModelUnavailableCode(code: string | null): boolean {
    if (!code) return false;
    return code === "model_decommissioned"
        || code === "model_not_found"
        || code === "unsupported_model";
}

function hasUnavailableModelMessage(error: unknown): boolean {
    if (!isRecord(error) || typeof error.message !== "string") return false;
    const normalized = error.message.toLowerCase();
    return normalized.includes("decommissioned")
        || normalized.includes("no longer supported")
        || normalized.includes("model not found")
        || normalized.includes("unsupported model");
}

function mapGroqReasoningEffort(modelId: string, effort: "none" | "low" | "medium" | "high"): "none" | "low" | "medium" | "high" | "default" {
    if (effort === "none") return "none";
    const normalized = modelId.trim().toLowerCase();
    // Qwen3 models accept `default` and `none` in Groq's reasoning API.
    if (normalized.includes("qwen3") || normalized.includes("qwen/qwen3")) {
        return "default";
    }
    return effort;
}

export class GroqClient implements LLMClient {
    public readonly supportsNativeToolCalling = true;
    private client: Groq;
    private model: string;
    private discoveredFallbackModel: string | null | undefined;

    constructor(apiKey: string, model: string = "llama-3.3-70b-versatile") {
        if (!apiKey) throw new Error("API Key is required for GroqClient");
        this.client = new Groq({ apiKey, dangerouslyAllowBrowser: true });
        this.model = model;
        this.discoveredFallbackModel = undefined;
    }

    private buildRequestPayload(messages: LLMMessage[], options?: LLMChatOptions): ChatCompletionCreateParamsNonStreaming {
        const requestPayload: ChatCompletionCreateParamsNonStreaming = {
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

        if (options?.reasoningEffort && options.reasoningEffort !== "none" && supportsGroqReasoningEffort(this.model)) {
            requestPayload.reasoning_effort = mapGroqReasoningEffort(this.model, options.reasoningEffort);
        }

        return requestPayload;
    }

    private async resolveFallbackModel(): Promise<string | null> {
        if (this.discoveredFallbackModel !== undefined) {
            return this.discoveredFallbackModel;
        }

        try {
            const listed = await this.client.models.list();
            const availableIds = (Array.isArray(listed.data) ? listed.data : [])
                .map((entry) => String(entry.id || "").trim())
                .filter((id) => id.length > 0);

            if (availableIds.length === 0) {
                this.discoveredFallbackModel = null;
                return null;
            }

            const availableByNormalized = new Map<string, string>();
            for (const id of availableIds) {
                availableByNormalized.set(id.toLowerCase(), id);
            }

            for (const candidate of GROQ_PREFERRED_CHAT_FALLBACK_MODELS) {
                const match = availableByNormalized.get(candidate.toLowerCase());
                if (match) {
                    this.discoveredFallbackModel = match;
                    return match;
                }
            }

            const firstLikelyChat = availableIds.find((id) => isLikelyChatModel(id));
            this.discoveredFallbackModel = firstLikelyChat || availableIds[0] || null;
            return this.discoveredFallbackModel;
        } catch (error: unknown) {
            console.error("Groq model discovery failed:", error);
            this.discoveredFallbackModel = undefined;
            return null;
        }
    }

    private async retryWithFallbackModel(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse | null> {
        const fallbackModel = await this.resolveFallbackModel();
        if (!fallbackModel) return null;

        if (fallbackModel.toLowerCase() === this.model.toLowerCase()) {
            return null;
        }

        const previousModel = this.model;
        this.model = fallbackModel;
        console.warn(`Groq model '${previousModel}' unavailable. Retrying with '${fallbackModel}'.`);

        try {
            return await this.chatInternal(messages, options, false);
        } catch (error: unknown) {
            console.error("Groq fallback model retry failed:", error);
            throw error;
        }
    }

    private async chatInternal(messages: LLMMessage[], options?: LLMChatOptions, allowModelRecovery: boolean = true): Promise<LLMResponse> {
        try {
            const requestPayload = this.buildRequestPayload(messages, options);
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
        } catch (error: unknown) {
            const { code, failedGeneration } = extractGroqErrorDetails(error);
            const isModelUnavailable = isModelUnavailableCode(code) || hasUnavailableModelMessage(error);

            if (allowModelRecovery && isModelUnavailable) {
                const recovered = await this.retryWithFallbackModel(messages, options);
                if (recovered) {
                    return recovered;
                }
            }

            if (code === "tool_use_failed") {
                if (failedGeneration) {
                    const recoveredCall = parseFailedGenerationToolCallCompat(failedGeneration);
                    if (recoveredCall) {
                        const recoveredArgKeys = (() => {
                            try {
                                const parsed = JSON.parse(recoveredCall.argumentsText) as Record<string, unknown>;
                                return Object.keys(parsed);
                            } catch {
                                return [];
                            }
                        })();
                        console.warn("Groq tool_use_failed recovered by parsing failed_generation.", {
                            tool: recoveredCall.name,
                            argKeys: recoveredArgKeys,
                        });
                        return {
                            content: "",
                            toolCalls: [recoveredCall],
                            usage: { total_tokens: 0 },
                        };
                    }
                }

                // Last-resort fallback: retry once without tools to avoid failing the whole turn.
                try {
                    const fallbackPayload: ChatCompletionCreateParamsNonStreaming = {
                        messages: messages.map(m => ({ role: m.role, content: m.content })),
                        model: this.model,
                        temperature: options?.temperature ?? 0.7,
                        max_tokens: options?.max_tokens ?? 4096,
                    };

                    if (options?.reasoningEffort && options.reasoningEffort !== "none" && supportsGroqReasoningEffort(this.model)) {
                        fallbackPayload.reasoning_effort = mapGroqReasoningEffort(this.model, options.reasoningEffort);
                    }

                    const fallbackCompletion = await this.client.chat.completions.create(fallbackPayload);

                    const fallbackMessage = fallbackCompletion.choices[0]?.message;
                    return {
                        content: fallbackMessage?.content || "",
                        usage: {
                            total_tokens: fallbackCompletion.usage?.total_tokens || 0,
                        },
                    };
                } catch (fallbackError) {
                    console.error("Groq fallback retry failed:", fallbackError);
                }
            }

            console.error("Groq API Error:", error);
            throw error;
        }
    }

    async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse> {
        return this.chatInternal(messages, options, true);
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
