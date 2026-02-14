import fs from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import {
    buildFallbackCatalogProviders,
    CatalogModel,
    ModelCapabilities,
    ModelMetadata,
    CatalogProvider,
    defaultModelForCatalogProvider,
    inferModelCapabilities,
    toCatalogModel,
} from "@/lib/llm/modelCatalog";
import { getEnvVariable } from "@/lib/env";
import { debugRouteError, debugRouteLog, isDebugRequest } from "@/lib/debug/server";

const CACHE_DIR = path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "llm-model-catalog.json");
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_PROBE_MODELS_PER_PROVIDER = 8;

const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
    groq: "GROQ_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
};

interface CachedModelCatalog {
    updatedAt: number;
    providers: CatalogProvider[];
}

interface RemoteModelRecord {
    id: string;
    label: string;
    description?: string;
    hints?: Parameters<typeof inferModelCapabilities>[2];
    metadata?: ModelMetadata;
}

async function readCache(): Promise<CachedModelCatalog | null> {
    try {
        const raw = await fs.readFile(CACHE_FILE, "utf8");
        const parsed = JSON.parse(raw) as CachedModelCatalog;
        if (!Array.isArray(parsed.providers)) return null;
        if (typeof parsed.updatedAt !== "number") return null;
        return parsed;
    } catch {
        return null;
    }
}

async function writeCache(payload: CachedModelCatalog) {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

async function resolveApiKeys(req: NextRequest): Promise<Record<string, string | null>> {
    const rawHeaderKeys = req.headers.get("x-api-keys");
    let clientKeys: Record<string, string> = {};

    if (rawHeaderKeys) {
        try {
            const parsed = JSON.parse(rawHeaderKeys) as Record<string, string>;
            if (parsed && typeof parsed === "object") {
                clientKeys = parsed;
            }
        } catch {
            // ignore malformed local keys
        }
    }

    const resolved: Record<string, string | null> = {};
    for (const [providerId, envVar] of Object.entries(PROVIDER_ENV_KEY_MAP)) {
        const headerKey = clientKeys[providerId];
        if (typeof headerKey === "string" && headerKey.trim().length > 0 && headerKey !== "null") {
            resolved[providerId] = headerKey.trim();
            continue;
        }
        resolved[providerId] = await getEnvVariable(envVar);
    }

    return resolved;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
    if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
    return String(value);
}

function enrichDescription(baseDescription: string | undefined, metadata: ModelMetadata | undefined): string | undefined {
    const extras: string[] = [];
    if (typeof metadata?.contextWindow === "number" && metadata.contextWindow > 0) {
        extras.push(`${formatTokenCount(metadata.contextWindow)} ctx`);
    }
    if (typeof metadata?.maxOutputTokens === "number" && metadata.maxOutputTokens > 0) {
        extras.push(`${formatTokenCount(metadata.maxOutputTokens)} out`);
    }
    if (Array.isArray(metadata?.inputModalities) && metadata.inputModalities.length > 0) {
        extras.push(`in: ${metadata.inputModalities.join(",")}`);
    }
    if (Array.isArray(metadata?.outputModalities) && metadata.outputModalities.length > 0) {
        extras.push(`out: ${metadata.outputModalities.join(",")}`);
    }

    const summary = extras.join(" | ");
    if (!baseDescription && !summary) return undefined;
    if (!baseDescription) return summary;
    if (!summary) return baseDescription;
    return `${baseDescription} (${summary})`;
}

function dedupeAndSortModels(models: CatalogModel[]): CatalogModel[] {
    const byId = new Map<string, CatalogModel>();
    for (const model of models) {
        const id = model.id.trim();
        if (!id) continue;
        byId.set(id, { ...model, id });
    }

    return Array.from(byId.values()).sort((a, b) => {
        if (a.capabilities.chat !== b.capabilities.chat) {
            return a.capabilities.chat ? -1 : 1;
        }
        return a.label.localeCompare(b.label);
    });
}

function mergeProviderModels(providerId: string, fallbackModels: CatalogModel[], remoteModels: RemoteModelRecord[]): CatalogModel[] {
    if (remoteModels.length === 0) {
        return dedupeAndSortModels(fallbackModels);
    }

    const fallbackById = new Map(fallbackModels.map((model) => [model.id, model]));
    const merged: CatalogModel[] = [];

    for (const remote of remoteModels) {
        const fallback = fallbackById.get(remote.id);
        const metadata: ModelMetadata = {
            ...(fallback?.metadata || {}),
            ...(remote.metadata || {}),
            assessment: {
                source: remote.hints ? "provider" : "inferred",
                assessedAt: Date.now(),
                notes: remote.hints ? "Capabilities sourced from provider metadata plus inference." : "Capabilities inferred from model id and provider defaults.",
            },
        };
        merged.push(toCatalogModel(providerId, {
            id: remote.id,
            label: remote.label || fallback?.label || remote.id,
            description: enrichDescription(remote.description || fallback?.description, metadata),
        }, remote.hints, metadata));
    }

    return dedupeAndSortModels(merged);
}

async function fetchOpenAIModels(apiKey: string): Promise<RemoteModelRecord[]> {
    const response = await fetchWithTimeout("https://api.openai.com/v1/models", {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
        },
    });
    if (!response.ok) {
        throw new Error(`OpenAI list models failed: ${response.status}`);
    }

    const data = await response.json() as {
        data?: Array<{ id?: string; created?: number; owned_by?: string }>;
    };
    const models: RemoteModelRecord[] = [];
    for (const entry of (Array.isArray(data.data) ? data.data : [])) {
        const id = String(entry.id || "").trim();
        if (!id) continue;
        models.push({
            id,
            label: id,
            metadata: {
                createdAt: typeof entry.created === "number" ? entry.created : undefined,
                ownedBy: typeof entry.owned_by === "string" ? entry.owned_by : undefined,
            },
        });
    }
    return models;
}

async function fetchGroqModels(apiKey: string): Promise<RemoteModelRecord[]> {
    const response = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
        },
    });
    if (!response.ok) {
        throw new Error(`Groq list models failed: ${response.status}`);
    }

    const data = await response.json() as {
        data?: Array<{
            id?: string;
            created?: number;
            owned_by?: string;
            context_window?: number;
            max_completion_tokens?: number;
            input_modalities?: string[];
            output_modalities?: string[];
        }>;
    };
    const models: RemoteModelRecord[] = [];
    for (const entry of (Array.isArray(data.data) ? data.data : [])) {
        const id = String(entry.id || "").trim();
        if (!id) continue;
        models.push({
            id,
            label: id,
            metadata: {
                createdAt: typeof entry.created === "number" ? entry.created : undefined,
                ownedBy: typeof entry.owned_by === "string" ? entry.owned_by : undefined,
                contextWindow: typeof entry.context_window === "number" ? entry.context_window : undefined,
                maxOutputTokens: typeof entry.max_completion_tokens === "number" ? entry.max_completion_tokens : undefined,
                inputModalities: Array.isArray(entry.input_modalities) ? entry.input_modalities : undefined,
                outputModalities: Array.isArray(entry.output_modalities) ? entry.output_modalities : undefined,
            },
        });
    }
    return models;
}

async function fetchAnthropicModels(apiKey: string): Promise<RemoteModelRecord[]> {
    const response = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            Accept: "application/json",
        },
    });
    if (!response.ok) {
        throw new Error(`Anthropic list models failed: ${response.status}`);
    }

    const data = await response.json() as {
        data?: Array<{
            id?: string;
            display_name?: string;
            description?: string;
            created_at?: string | number;
            input_token_limit?: number;
            output_token_limit?: number;
        }>;
    };
    const models: RemoteModelRecord[] = [];
    for (const entry of (Array.isArray(data.data) ? data.data : [])) {
        const id = String(entry.id || "").trim();
        if (!id) continue;
        const parsedCreatedAt = typeof entry.created_at === "string"
            ? Date.parse(entry.created_at)
            : (typeof entry.created_at === "number" ? entry.created_at : undefined);
        models.push({
            id,
            label: String(entry.display_name || id).trim(),
            description: String(entry.description || "").trim() || undefined,
            metadata: {
                createdAt: typeof parsedCreatedAt === "number" && !Number.isNaN(parsedCreatedAt)
                    ? parsedCreatedAt
                    : undefined,
                contextWindow: typeof entry.input_token_limit === "number" ? entry.input_token_limit : undefined,
                maxOutputTokens: typeof entry.output_token_limit === "number" ? entry.output_token_limit : undefined,
            },
        });
    }
    return models;
}

async function fetchGoogleModels(apiKey: string): Promise<RemoteModelRecord[]> {
    const response = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { headers: { Accept: "application/json" } },
    );
    if (!response.ok) {
        throw new Error(`Google list models failed: ${response.status}`);
    }

    const data = await response.json() as {
        models?: Array<{
            name?: string;
            displayName?: string;
            description?: string;
            inputTokenLimit?: number;
            outputTokenLimit?: number;
            supportedInputModalities?: string[];
            supportedOutputModalities?: string[];
            supportedGenerationMethods?: string[];
        }>;
    };

    const models: RemoteModelRecord[] = [];
    for (const entry of (Array.isArray(data.models) ? data.models : [])) {
        const rawName = String(entry.name || "").trim();
        const id = rawName.replace(/^models\//i, "").trim();
        if (!id) continue;

        const methods = Array.isArray(entry.supportedGenerationMethods)
            ? entry.supportedGenerationMethods.map((method) => method.toLowerCase())
            : [];
        const supportsContentGen = methods.includes("generatecontent")
            || methods.includes("streamgeneratecontent");
        const supportsEmbeddings = methods.includes("embedcontent")
            || methods.includes("batchembedcontents");

        models.push({
            id,
            label: String(entry.displayName || id).trim(),
            description: String(entry.description || "").trim() || undefined,
            hints: {
                chat: supportsContentGen,
                embeddings: supportsEmbeddings,
            },
            metadata: {
                contextWindow: typeof entry.inputTokenLimit === "number" ? entry.inputTokenLimit : undefined,
                maxOutputTokens: typeof entry.outputTokenLimit === "number" ? entry.outputTokenLimit : undefined,
                supportedGenerationMethods: Array.isArray(entry.supportedGenerationMethods)
                    ? entry.supportedGenerationMethods
                    : undefined,
                inputModalities: Array.isArray(entry.supportedInputModalities)
                    ? entry.supportedInputModalities
                    : undefined,
                outputModalities: Array.isArray(entry.supportedOutputModalities)
                    ? entry.supportedOutputModalities
                    : undefined,
            },
        });
    }
    return models;
}

async function fetchRemoteModels(providerId: string, apiKey: string): Promise<RemoteModelRecord[]> {
    if (providerId === "openai") return fetchOpenAIModels(apiKey);
    if (providerId === "groq") return fetchGroqModels(apiKey);
    if (providerId === "anthropic") return fetchAnthropicModels(apiKey);
    if (providerId === "google") return fetchGoogleModels(apiKey);
    return [];
}

function isTransientProbeStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isExplicitReasoningUnsupported(details: string): boolean {
    const normalized = details.toLowerCase();
    if (!normalized.includes("reason")) return false;
    return normalized.includes("unsupported")
        || normalized.includes("not supported")
        || normalized.includes("unknown")
        || normalized.includes("invalid")
        || normalized.includes("unrecognized");
}

function isExplicitToolUseUnsupported(details: string): boolean {
    const normalized = details.toLowerCase();
    if (!(normalized.includes("tool") || normalized.includes("function"))) return false;
    return normalized.includes("not supported")
        || normalized.includes("unsupported")
        || normalized.includes("does not support")
        || normalized.includes("invalid")
        || normalized.includes("unrecognized");
}

async function probeOpenAICompatibleModel(
    endpointBase: string,
    apiKey: string,
    modelId: string,
): Promise<Partial<ModelCapabilities> | null> {
    const chatResponse = await fetchWithTimeout(`${endpointBase}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0,
        }),
    });

    if (!chatResponse.ok) {
        if (isTransientProbeStatus(chatResponse.status)) return null;
        return { chat: false, reasoning: false };
    }

    let nativeTools: boolean | undefined;
    const toolUseResponse = await fetchWithTimeout(`${endpointBase}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0,
            tools: [{
                type: "function",
                function: {
                    name: "ping_tool_probe",
                    description: "Capability probe tool.",
                    parameters: {
                        type: "object",
                        properties: {
                            ok: { type: "boolean" },
                        },
                    },
                },
            }],
            tool_choice: "auto",
        }),
    });

    if (!toolUseResponse.ok) {
        if (!isTransientProbeStatus(toolUseResponse.status)) {
            const details = (await toolUseResponse.text()).trim();
            if (isExplicitToolUseUnsupported(details)) {
                nativeTools = false;
            }
        }
    } else {
        nativeTools = true;
    }

    const reasoningResponse = await fetchWithTimeout(`${endpointBase}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0,
            reasoning_effort: "low",
        }),
    });

    if (!reasoningResponse.ok) {
        if (isTransientProbeStatus(reasoningResponse.status)) {
            return typeof nativeTools === "boolean"
                ? { chat: true, nativeTools }
                : { chat: true };
        }
        const details = (await reasoningResponse.text()).trim();
        if (isExplicitReasoningUnsupported(details)) {
            return typeof nativeTools === "boolean"
                ? { chat: true, reasoning: false, nativeTools }
                : { chat: true, reasoning: false };
        }
        return typeof nativeTools === "boolean"
            ? { chat: true, nativeTools }
            : { chat: true };
    }

    return typeof nativeTools === "boolean"
        ? { chat: true, reasoning: true, nativeTools }
        : { chat: true, reasoning: true };
}

async function probeAnthropicModel(apiKey: string, modelId: string): Promise<Partial<ModelCapabilities> | null> {
    const chatResponse = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: modelId,
            max_tokens: 16,
            messages: [{ role: "user", content: "ping" }],
        }),
    });

    if (!chatResponse.ok) {
        if (isTransientProbeStatus(chatResponse.status)) return null;
        return { chat: false, reasoning: false };
    }

    const reasoningResponse = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: modelId,
            max_tokens: 16,
            messages: [{ role: "user", content: "ping" }],
            thinking: {
                type: "enabled",
                budget_tokens: 512,
            },
        }),
    });

    if (!reasoningResponse.ok) {
        if (isTransientProbeStatus(reasoningResponse.status)) {
            return { chat: true };
        }
        const details = (await reasoningResponse.text()).trim();
        if (isExplicitReasoningUnsupported(details)) {
            return { chat: true, reasoning: false };
        }
        return { chat: true };
    }

    return { chat: true, reasoning: true };
}

async function probeGoogleModel(apiKey: string, modelId: string): Promise<Partial<ModelCapabilities> | null> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const chatResponse = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            contents: [
                {
                    role: "user",
                    parts: [{ text: "ping" }],
                },
            ],
            generationConfig: {
                maxOutputTokens: 8,
                temperature: 0,
            },
        }),
    });

    if (!chatResponse.ok) {
        if (isTransientProbeStatus(chatResponse.status)) return null;
        return { chat: false, reasoning: false };
    }

    const reasoningResponse = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            contents: [
                {
                    role: "user",
                    parts: [{ text: "ping" }],
                },
            ],
            generationConfig: {
                maxOutputTokens: 8,
                temperature: 0,
                thinkingConfig: {
                    thinkingBudget: 256,
                },
            },
        }),
    });

    if (!reasoningResponse.ok) {
        if (isTransientProbeStatus(reasoningResponse.status)) {
            return { chat: true };
        }
        const details = (await reasoningResponse.text()).trim();
        if (isExplicitReasoningUnsupported(details)) {
            return { chat: true, reasoning: false };
        }
        return { chat: true };
    }

    return { chat: true, reasoning: true };
}

async function probeProviderModel(
    providerId: string,
    apiKey: string,
    modelId: string,
): Promise<Partial<ModelCapabilities> | null> {
    if (providerId === "openai") {
        return probeOpenAICompatibleModel("https://api.openai.com/v1", apiKey, modelId);
    }
    if (providerId === "groq") {
        return probeOpenAICompatibleModel("https://api.groq.com/openai/v1", apiKey, modelId);
    }
    if (providerId === "anthropic") {
        return probeAnthropicModel(apiKey, modelId);
    }
    if (providerId === "google") {
        return probeGoogleModel(apiKey, modelId);
    }
    return null;
}

async function applyCapabilityProbes(
    providerId: string,
    apiKey: string,
    models: CatalogModel[],
    debugEnabled: boolean,
): Promise<CatalogModel[]> {
    const candidates = models
        .filter((model) => model.capabilities.chat || model.label.toLowerCase().includes("chat"))
        .slice(0, MAX_PROBE_MODELS_PER_PROVIDER);
    if (candidates.length === 0) return models;

    const overrides = new Map<string, Partial<ModelCapabilities>>();
    for (const model of candidates) {
        try {
            const result = await probeProviderModel(providerId, apiKey, model.id);
            if (result) {
                overrides.set(model.id, result);
            }
        } catch (error: unknown) {
            debugRouteError(debugEnabled, "api/llm/models", `Capability probe failed for ${providerId}/${model.id}`, error);
        }
    }

    if (overrides.size === 0) return models;

    const now = Date.now();
    return models.map((model) => {
        const override = overrides.get(model.id);
        if (!override) return model;

        const nextCapabilities: ModelCapabilities = {
            ...model.capabilities,
            ...override,
        };
        if (!nextCapabilities.chat) {
            nextCapabilities.reasoning = false;
        }

        const priorSource = model.metadata?.assessment?.source;
        const source = priorSource === "provider"
            ? "provider+probe"
            : "probe";

        return {
            ...model,
            capabilities: nextCapabilities,
            metadata: {
                ...(model.metadata || {}),
                assessment: {
                    source,
                    assessedAt: now,
                    notes: "Capabilities were probed using lightweight provider API calls during manual refresh.",
                },
            },
        };
    });
}

async function buildProviderCatalog(
    req: NextRequest,
    debugEnabled: boolean,
    probeCapabilities: boolean,
): Promise<CatalogProvider[]> {
    const fallbackProviders = buildFallbackCatalogProviders();
    const apiKeys = await resolveApiKeys(req);

    const providers = await Promise.all(fallbackProviders.map(async (fallbackProvider) => {
        const providerId = fallbackProvider.id;
        const apiKey = apiKeys[providerId];
        if (!apiKey) {
            return {
                ...fallbackProvider,
                models: dedupeAndSortModels(fallbackProvider.models),
                defaultModel: defaultModelForCatalogProvider(fallbackProvider),
            };
        }

        try {
            const remoteModels = await fetchRemoteModels(providerId, apiKey);
            const mergedModels = mergeProviderModels(providerId, fallbackProvider.models, remoteModels);
            const withDynamicAssessment = probeCapabilities
                ? await applyCapabilityProbes(providerId, apiKey, mergedModels, debugEnabled)
                : mergedModels;
            const withChatFallback = withDynamicAssessment.length > 0
                ? withDynamicAssessment
                : fallbackProvider.models;

            return {
                ...fallbackProvider,
                models: withChatFallback,
                defaultModel: defaultModelForCatalogProvider({
                    ...fallbackProvider,
                    models: withChatFallback,
                }),
            };
        } catch (error: unknown) {
            debugRouteError(debugEnabled, "api/llm/models", `Failed to fetch ${providerId} models; using fallback`, error);
            return {
                ...fallbackProvider,
                models: dedupeAndSortModels(fallbackProvider.models),
                defaultModel: defaultModelForCatalogProvider(fallbackProvider),
            };
        }
    }));

    return providers;
}

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    try {
        const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
        const probeCapabilities = req.nextUrl.searchParams.get("probe") === "1";
        const cache = await readCache();
        const isFresh = cache ? (Date.now() - cache.updatedAt) < CACHE_TTL_MS : false;
        debugRouteLog(debugEnabled, "api/llm/models", "GET request started", {
            forceRefresh,
            probeCapabilities,
            cachePresent: Boolean(cache),
            cacheFresh: isFresh,
        });

        if (cache && isFresh && !forceRefresh) {
            return NextResponse.json({
                providers: cache.providers,
                cached: true,
                updatedAt: cache.updatedAt,
            });
        }

        const providers = await buildProviderCatalog(req, debugEnabled, probeCapabilities);
        const payload: CachedModelCatalog = {
            updatedAt: Date.now(),
            providers,
        };
        await writeCache(payload);

        debugRouteLog(debugEnabled, "api/llm/models", "Fetched and cached model catalog", {
            providerCount: providers.length,
            modelCount: providers.reduce((count, provider) => count + provider.models.length, 0),
        });

        return NextResponse.json({
            providers,
            cached: false,
            updatedAt: payload.updatedAt,
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/llm/models", "Unhandled error in GET", error);
        const cache = await readCache();
        if (cache) {
            return NextResponse.json({
                providers: cache.providers,
                cached: true,
                stale: true,
                updatedAt: cache.updatedAt,
            }, { status: 200 });
        }

        return NextResponse.json(
            {
                error: "Failed to load model catalog",
                details: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 500 },
        );
    }
}
