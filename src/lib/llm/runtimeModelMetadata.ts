import fs from "fs/promises";
import path from "path";

const CATALOG_CACHE_PATH = path.join(process.cwd(), ".cache", "llm-model-catalog.json");
const IN_MEMORY_CACHE_TTL_MS = 60_000;

interface CatalogCacheModel {
    id?: string;
    metadata?: {
        contextWindow?: number;
    };
}

interface CatalogCacheProvider {
    id?: string;
    models?: CatalogCacheModel[];
}

interface CatalogCachePayload {
    updatedAt?: number;
    providers?: CatalogCacheProvider[];
}

let cacheState: {
    loadedAt: number;
    payload: CatalogCachePayload | null;
} | null = null;

function normalizeId(value: string): string {
    return value.trim().toLowerCase();
}

function isFinitePositiveNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function readCatalogCache(): Promise<CatalogCachePayload | null> {
    const now = Date.now();
    if (cacheState && (now - cacheState.loadedAt) < IN_MEMORY_CACHE_TTL_MS) {
        return cacheState.payload;
    }

    try {
        const raw = await fs.readFile(CATALOG_CACHE_PATH, "utf-8");
        const parsed = JSON.parse(raw) as CatalogCachePayload;
        cacheState = {
            loadedAt: now,
            payload: parsed && typeof parsed === "object" ? parsed : null,
        };
        return cacheState.payload;
    } catch {
        cacheState = {
            loadedAt: now,
            payload: null,
        };
        return null;
    }
}

export async function resolveContextWindowTokensFromCatalog(
    providerId: string,
    modelId: string,
): Promise<number | null> {
    const normalizedProviderId = normalizeId(providerId);
    const normalizedModelId = normalizeId(modelId);
    if (!normalizedProviderId || !normalizedModelId) return null;

    const catalog = await readCatalogCache();
    const providers = Array.isArray(catalog?.providers) ? catalog?.providers : [];
    const provider = providers.find((candidate) => normalizeId(String(candidate?.id || "")) === normalizedProviderId);
    const scopedModels = Array.isArray(provider?.models) ? provider.models : [];

    const directMatch = scopedModels.find((candidate) => normalizeId(String(candidate?.id || "")) === normalizedModelId);
    const contextWindow = directMatch?.metadata?.contextWindow;
    if (isFinitePositiveNumber(contextWindow)) {
        return Math.floor(contextWindow);
    }

    for (const fallbackProvider of providers) {
        const models = Array.isArray(fallbackProvider?.models) ? fallbackProvider.models : [];
        const crossMatch = models.find((candidate) => normalizeId(String(candidate?.id || "")) === normalizedModelId);
        const crossContext = crossMatch?.metadata?.contextWindow;
        if (isFinitePositiveNumber(crossContext)) {
            return Math.floor(crossContext);
        }
    }

    return null;
}

