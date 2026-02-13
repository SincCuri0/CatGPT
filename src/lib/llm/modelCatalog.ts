import { Model, ProviderInfo, PROVIDERS } from "./constants";

export interface ModelCapabilities {
    chat: boolean;
    reasoning: boolean;
    nativeTools: boolean;
    speechToText: boolean;
    textToSpeech: boolean;
    embeddings: boolean;
}

export interface ModelCapabilityAssessment {
    source: "inferred" | "provider" | "probe" | "provider+probe";
    assessedAt?: number;
    notes?: string;
}

export interface ModelMetadata {
    ownedBy?: string;
    createdAt?: number;
    contextWindow?: number;
    maxOutputTokens?: number;
    inputModalities?: string[];
    outputModalities?: string[];
    supportedGenerationMethods?: string[];
    assessment?: ModelCapabilityAssessment;
}

export interface CatalogModel extends Model {
    capabilities: ModelCapabilities;
    metadata?: ModelMetadata;
}

export interface CatalogProvider extends Omit<ProviderInfo, "models"> {
    models: CatalogModel[];
}

export interface ModelCatalogPayload {
    providers: CatalogProvider[];
    updatedAt: number;
    cached?: boolean;
    stale?: boolean;
}

export interface ModelCapabilityRequirements {
    requireToolUse?: boolean;
    requireReasoning?: boolean;
}

const KNOWN_DEPRECATED_MODELS: Record<string, Set<string>> = {
    groq: new Set([
        "mixtral-8x7b-32768",
        "llama-guard-3-8b",
        "llama-3.2-1b-preview",
        "llama-3.2-3b-preview",
        "llama-3.2-11b-vision-preview",
        "llama-3.2-90b-vision-preview",
        "deepseek-r1-distill-qwen-32b",
        "qwen-2.5-32b",
        "qwen-2.5-coder-32b",
        "llama-3.3-70b-specdec",
        "deepseek-r1-distill-llama-70b-specdec",
        "llama-3.1-70b-versatile",
        "llama-3.1-70b-specdec",
    ]),
};

function normalizeModelId(modelId: string): string {
    return modelId.trim().toLowerCase();
}

function hasAnyPrefix(value: string, prefixes: string[]): boolean {
    return prefixes.some((prefix) => value.startsWith(prefix));
}

function matchesPreference(modelId: string, preference: string): boolean {
    const normalizedId = normalizeModelId(modelId);
    const normalizedPreference = normalizeModelId(preference);
    return normalizedId === normalizedPreference
        || normalizedId.startsWith(`${normalizedPreference}-`)
        || normalizedId.includes(normalizedPreference);
}

const TOOL_MODEL_PREFERENCES: Record<string, string[]> = {
    // Source references:
    // - Groq tool use + reasoning support: https://console.groq.com/docs/tool-use and https://console.groq.com/docs/reasoning
    // - OpenAI model feature pages (e.g., GPT-5.1, GPT-4o): https://platform.openai.com/docs/models
    // - Anthropic tool use model guidance: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
    // - Google Gemini model capabilities table: https://ai.google.dev/gemini-api/docs/models
    groq: ["gpt-oss-20b", "gpt-oss-120b", "llama-3.3-70b-versatile", "qwen/qwen3-32b", "llama-3.1-8b-instant"],
    openai: ["gpt-5.1", "gpt-5", "gpt-4o", "gpt-4.1", "gpt-4o-mini", "o4-mini", "o3"],
    anthropic: ["claude-sonnet-4-5", "claude-sonnet-4", "claude-3-7-sonnet", "claude-opus-4", "claude-3-5-haiku"],
    google: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-pro"],
};

const REASONING_MODEL_PREFERENCES: Record<string, string[]> = {
    groq: ["gpt-oss-120b", "gpt-oss-20b", "qwen/qwen3-32b"],
    openai: ["gpt-5.1", "gpt-5", "o4-mini", "o3", "o1"],
    anthropic: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-opus-4-5", "claude-3-7-sonnet", "claude-sonnet-4"],
    google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-pro", "gemini-3-flash", "gemini-2.5-flash-lite"],
};

function supportsOpenAIToolUse(modelId: string): boolean {
    const normalized = normalizeModelId(modelId);
    if (!normalized) return false;
    if (hasAnyToken(normalized, ["whisper", "transcrib", "embedding", "moderation", "tts", "audio"])) {
        return false;
    }
    if (normalized === "gpt-4") return false;
    if (normalized.startsWith("gpt-4-")) return false;
    return normalized.startsWith("gpt-")
        || hasAnyPrefix(normalized, ["o1", "o3", "o4", "o5"])
        || normalized.startsWith("chatgpt-");
}

function supportsGroqToolUse(modelId: string): boolean {
    const normalized = normalizeModelId(modelId);
    if (!normalized) return false;
    if (hasAnyToken(normalized, ["whisper", "transcrib", "embedding", "moderation", "guard", "tts", "speech"])) {
        return false;
    }
    // Groq's Compound systems currently don't support local/remote tool use in the same way
    // as standard function-calling models.
    if (normalized.includes("compound")) return false;
    return true;
}

function supportsAnthropicToolUse(modelId: string): boolean {
    const normalized = normalizeModelId(modelId);
    return normalized.includes("claude");
}

function supportsGoogleToolUse(modelId: string): boolean {
    const normalized = normalizeModelId(modelId);
    if (!normalized.includes("gemini")) return false;
    if (hasAnyToken(normalized, ["embedding", "aqa", "tts", "image-generation", "imagen", "veo", "learnlm"])) {
        return false;
    }
    return true;
}

export function supportsToolUse(providerId: string, modelId: string): boolean {
    const normalizedProvider = providerId.trim().toLowerCase();
    if (normalizedProvider === "openai") return supportsOpenAIToolUse(modelId);
    if (normalizedProvider === "groq") return supportsGroqToolUse(modelId);
    if (normalizedProvider === "anthropic") return supportsAnthropicToolUse(modelId);
    if (normalizedProvider === "google") return supportsGoogleToolUse(modelId);
    return false;
}

export function isKnownDeprecatedModel(providerId: string, modelId: string): boolean {
    const provider = providerId.trim().toLowerCase();
    const deprecated = KNOWN_DEPRECATED_MODELS[provider];
    if (!deprecated) return false;
    return deprecated.has(normalizeModelId(modelId));
}

function hasAnyToken(value: string, tokens: string[]): boolean {
    return tokens.some((token) => value.includes(token));
}

export function supportsGroqReasoningEffort(modelId: string): boolean {
    const normalized = normalizeModelId(modelId);
    // Groq reasoning support is currently scoped to GPT-OSS and Qwen3 models.
    return hasAnyToken(normalized, ["gpt-oss", "qwen3", "qwen/qwen3"]);
}

export function supportsOpenAIReasoningEffort(modelId: string): boolean {
    const normalized = normalizeModelId(modelId);
    return normalized.startsWith("o")
        || normalized.startsWith("gpt-5")
        || hasAnyToken(normalized, [
            "reason",
            "thinking",
            "o1",
            "o3",
            "o4",
            "o5",
        ]);
}

export function supportsAnthropicThinking(modelId: string): boolean {
    const normalized = normalizeModelId(modelId);
    return normalized.includes("3-7")
        || normalized.includes("4")
        || hasAnyToken(normalized, [
            "thinking",
            "sonnet-4",
            "opus-4",
            "haiku-4",
        ]);
}

export function supportsGoogleThinking(modelId: string): boolean {
    const normalized = normalizeModelId(modelId);
    return normalized.includes("2.5")
        || normalized.includes("gemini-3")
        || hasAnyToken(normalized, [
            "thinking",
            "flash-thinking",
            "pro-thinking",
        ]);
}

export function supportsReasoningEffort(providerId: string, modelId: string): boolean {
    const normalizedProvider = providerId.trim().toLowerCase();
    if (normalizedProvider === "groq") return supportsGroqReasoningEffort(modelId);
    if (normalizedProvider === "openai") return supportsOpenAIReasoningEffort(modelId);
    if (normalizedProvider === "anthropic") return supportsAnthropicThinking(modelId);
    if (normalizedProvider === "google") return supportsGoogleThinking(modelId);
    return false;
}

function inferChatCapability(providerId: string, modelId: string): boolean {
    const provider = providerId.trim().toLowerCase();
    const normalized = normalizeModelId(modelId);

    const isStt = normalized.includes("whisper")
        || normalized.includes("transcrib");
    const isTts = normalized.includes("tts")
        || normalized.includes("text-to-speech")
        || normalized.includes("speech");
    const isEmbedding = normalized.includes("embedding")
        || normalized.includes("embed");
    const isModeration = normalized.includes("moderation");

    if (isStt || isEmbedding || isModeration) return false;
    if (isTts && provider !== "google") return false;

    if (provider === "openai") {
        return normalized.startsWith("gpt-")
            || normalized.startsWith("o1")
            || normalized.startsWith("o3")
            || normalized.startsWith("o4")
            || normalized.startsWith("chatgpt");
    }

    if (provider === "anthropic") {
        return normalized.includes("claude");
    }

    if (provider === "google") {
        return normalized.includes("gemini");
    }

    if (provider === "groq") {
        return true;
    }

    return false;
}

export function inferModelCapabilities(
    providerId: string,
    modelId: string,
    hints?: Partial<ModelCapabilities>,
): ModelCapabilities {
    const normalized = normalizeModelId(modelId);
    const defaultCaps: ModelCapabilities = {
        chat: inferChatCapability(providerId, normalized),
        reasoning: supportsReasoningEffort(providerId, normalized),
        nativeTools: supportsToolUse(providerId, normalized),
        speechToText: normalized.includes("whisper") || normalized.includes("transcrib"),
        textToSpeech: normalized.includes("tts") || normalized.includes("text-to-speech"),
        embeddings: normalized.includes("embedding") || normalized.includes("embed"),
    };

    const merged: ModelCapabilities = {
        ...defaultCaps,
        ...(hints || {}),
    };

    if (!merged.chat) {
        merged.reasoning = false;
    }

    return merged;
}

export function toCatalogModel(
    providerId: string,
    model: Pick<Model, "id" | "label" | "description">,
    hints?: Partial<ModelCapabilities>,
    metadata?: ModelMetadata,
): CatalogModel {
    const id = model.id.trim();
    return {
        id,
        label: model.label?.trim() || id,
        description: model.description?.trim() || undefined,
        capabilities: inferModelCapabilities(providerId, id, hints),
        metadata,
    };
}

export function isModelChatCapable(model: Pick<CatalogModel, "id"> & { capabilities?: Partial<ModelCapabilities> }, providerId: string): boolean {
    if (typeof model.capabilities?.chat === "boolean") return model.capabilities.chat;
    return inferModelCapabilities(providerId, model.id).chat;
}

export function buildFallbackCatalogProviders(): CatalogProvider[] {
    return PROVIDERS.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => toCatalogModel(provider.id, model)),
    }));
}

export function defaultModelForCatalogProvider(provider: CatalogProvider): string {
    const chatModel = provider.models.find((model) => model.capabilities.chat);
    return chatModel?.id || provider.defaultModel;
}

export function modelMeetsCapabilityRequirements(
    providerId: string,
    model: Pick<CatalogModel, "id" | "capabilities">,
    requirements: ModelCapabilityRequirements = {},
): boolean {
    const supportsReasoning = typeof model.capabilities?.reasoning === "boolean"
        ? model.capabilities.reasoning
        : supportsReasoningEffort(providerId, model.id);
    const supportsNativeTools = typeof model.capabilities?.nativeTools === "boolean"
        ? model.capabilities.nativeTools
        : supportsToolUse(providerId, model.id);

    if (requirements.requireReasoning && !supportsReasoning) return false;
    if (requirements.requireToolUse && !supportsNativeTools) return false;
    return true;
}

export function filterModelsByCapabilityRequirements(
    providerId: string,
    models: CatalogModel[],
    requirements: ModelCapabilityRequirements = {},
): CatalogModel[] {
    return models.filter((model) => modelMeetsCapabilityRequirements(providerId, model, requirements));
}

function preferredModelIdForRequirements(
    providerId: string,
    models: CatalogModel[],
    requirements: ModelCapabilityRequirements = {},
): string | null {
    const providerKey = providerId.trim().toLowerCase();
    const preferenceBuckets: string[][] = [];
    if (requirements.requireReasoning) {
        preferenceBuckets.push(REASONING_MODEL_PREFERENCES[providerKey] || []);
    }
    if (requirements.requireToolUse) {
        preferenceBuckets.push(TOOL_MODEL_PREFERENCES[providerKey] || []);
    }
    if (preferenceBuckets.length === 0) {
        return null;
    }

    const mergedPreferences = Array.from(new Set(preferenceBuckets.flat()));
    for (const preferredId of mergedPreferences) {
        const match = models.find((candidate) => matchesPreference(candidate.id, preferredId));
        if (match) return match.id;
    }

    return null;
}

export function defaultModelForProviderWithRequirements(
    provider: CatalogProvider,
    requirements: ModelCapabilityRequirements = {},
): string {
    const chatModels = provider.models.filter((model) => isModelChatCapable(model, provider.id));
    const capableModels = filterModelsByCapabilityRequirements(provider.id, chatModels, requirements);
    const candidates = capableModels.length > 0 ? capableModels : chatModels;
    if (candidates.length === 0) return provider.defaultModel;

    const preferredId = preferredModelIdForRequirements(provider.id, candidates, requirements);
    if (preferredId) return preferredId;
    return candidates[0]?.id || provider.defaultModel;
}
