"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { debugClientError, debugClientLog } from "@/lib/debug/client";
import { buildFallbackCatalogProviders, CatalogProvider } from "@/lib/llm/modelCatalog";

const MODEL_CATALOG_CACHE_KEY = "cat_gpt_model_catalog";

interface ModelCatalogResponse {
    providers?: CatalogProvider[];
    cached?: boolean;
    updatedAt?: number;
}

function readCachedCatalog(): CatalogProvider[] | null {
    try {
        const raw = localStorage.getItem(MODEL_CATALOG_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ModelCatalogResponse;
        if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) return null;
        return parsed.providers;
    } catch {
        return null;
    }
}

export function useModelCatalog() {
    const { apiKeys, debugLogsEnabled } = useSettings();
    const [providers, setProviders] = useState<CatalogProvider[]>(() => buildFallbackCatalogProviders());
    const [isRefreshingModels, setIsRefreshingModels] = useState(false);

    const loadModelCatalog = useCallback(async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}) => {
        if (!forceRefresh) {
            const cached = readCachedCatalog();
            if (cached) {
                setProviders(cached);
                return;
            }
        } else {
            setIsRefreshingModels(true);
        }

        const endpoint = forceRefresh
            ? "/api/llm/models?refresh=1&probe=1"
            : "/api/llm/models";
        try {
            debugClientLog("useModelCatalog", `Requesting ${endpoint}`);
            const response = await fetch(endpoint, {
                headers: {
                    "x-api-keys": JSON.stringify(apiKeys),
                    ...(debugLogsEnabled ? { "x-debug-logs": "1" } : {}),
                },
            });
            if (!response.ok) {
                throw new Error(`Model catalog fetch failed (${response.status})`);
            }

            const data = await response.json() as ModelCatalogResponse;
            if (Array.isArray(data.providers) && data.providers.length > 0) {
                setProviders(data.providers);
                localStorage.setItem(MODEL_CATALOG_CACHE_KEY, JSON.stringify({
                    providers: data.providers,
                    updatedAt: data.updatedAt || Date.now(),
                }));
            }
        } catch (error: unknown) {
            debugClientError("useModelCatalog", error, "Failed to load model catalog");
        } finally {
            if (forceRefresh) {
                setIsRefreshingModels(false);
            }
        }
    }, [apiKeys, debugLogsEnabled]);

    useEffect(() => {
        void loadModelCatalog();
    }, [loadModelCatalog]);

    const providerById = useMemo(
        () => new Map(providers.map((provider) => [provider.id, provider])),
        [providers],
    );

    return {
        providers,
        providerById,
        isRefreshingModels,
        refreshModels: () => loadModelCatalog({ forceRefresh: true }),
    };
}
