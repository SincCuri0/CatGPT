"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { DEBUG_LOGS_STORAGE_KEY } from "@/lib/debug/constants";

interface SettingsContextType {
    // Legacy support
    apiKey: string | null;
    setApiKey: (key: string) => void;

    // New multi-provider support
    apiKeys: Record<string, string>;
    setProviderKey: (providerId: string, key: string) => void;
    serverConfiguredKeys: Record<string, boolean>;

    safeMode: boolean;
    setSafeMode: (mode: boolean) => void;
    debugLogsEnabled: boolean;
    setDebugLogsEnabled: (enabled: boolean) => void;
    themeMetadata: ThemeMetadata;
    setThemeMetadata: (theme: ThemeMetadata) => void;
}

interface ThemeMetadata {
    id: string;
    name: string;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);
const DEFAULT_THEME: ThemeMetadata = { id: "modern", name: "Sleek Synergy" };

function getInitialApiKeys(): Record<string, string> {
    if (typeof window === "undefined") return {};

    const storedKeysStr = localStorage.getItem("cat_gpt_api_keys");
    let localKeys: Record<string, string> = {};
    if (storedKeysStr) {
        try {
            localKeys = JSON.parse(storedKeysStr);
        } catch {
            localKeys = {};
        }
    }

    const oldGroqKey = localStorage.getItem("groq_api_key");
    if (oldGroqKey && !localKeys.groq) {
        localKeys.groq = oldGroqKey;
    }

    return localKeys;
}

function getInitialSafeMode(): boolean {
    if (typeof window === "undefined") return true;
    const storedSafeMode = localStorage.getItem("safe_mode");
    if (storedSafeMode === null) return true;
    return storedSafeMode === "true";
}

function getInitialDebugLogsEnabled(): boolean {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(DEBUG_LOGS_STORAGE_KEY) === "true";
}

function getInitialTheme(): ThemeMetadata {
    if (typeof window === "undefined") return DEFAULT_THEME;

    const storedTheme = localStorage.getItem("theme_metadata");
    if (!storedTheme) return DEFAULT_THEME;

    try {
        return JSON.parse(storedTheme);
    } catch {
        return DEFAULT_THEME;
    }
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
    // apiKeys: contains local keys (users enter these)
    const [apiKeys, setApiKeysState] = useState<Record<string, string>>(() => getInitialApiKeys());
    // serverConfiguredKeys: which keys are set on server (.env)
    const [serverConfiguredKeys, setServerConfiguredKeys] = useState<Record<string, boolean>>({});

    const [safeMode, setSafeModeState] = useState<boolean>(() => getInitialSafeMode());
    const [debugLogsEnabled, setDebugLogsEnabledState] = useState<boolean>(() => getInitialDebugLogsEnabled());
    const [themeMetadata, setThemeMetadataState] = useState<ThemeMetadata>(() => getInitialTheme());

    useEffect(() => {
        // Fetch server config status
        fetch('/api/settings', {
            headers: debugLogsEnabled ? { "x-debug-logs": "1" } : undefined,
        })
            .then(res => res.json())
            .then(data => {
                if (data.keysConfigured) {
                    setServerConfiguredKeys(data.keysConfigured);
                }
                // Optional: Sync legacy logic if needed, but 'keysConfigured' is enough for UI
            })
            .catch(e => console.error("Settings sync failed", e));
    }, [debugLogsEnabled]);

    const setProviderKey = async (providerId: string, key: string) => {
        const newKeys = { ...apiKeys, [providerId]: key };
        if (!key) delete newKeys[providerId]; // Remove if empty

        setApiKeysState(newKeys);
        localStorage.setItem("cat_gpt_api_keys", JSON.stringify(newKeys));

        // Sync legacy key if Groq
        if (providerId === "groq") {
            if (key) localStorage.setItem("groq_api_key", key);
            else localStorage.removeItem("groq_api_key");
        }

        // Persist to server (optional, for dev mode)
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(debugLogsEnabled ? { "x-debug-logs": "1" } : {}),
                },
                body: JSON.stringify({ apiKeys: { [providerId]: key } })
            });
        } catch (e) {
            console.error("Failed to persist API Key to server", e);
        }
    };

    // Legacy setter
    const setApiKey = (key: string) => setProviderKey("groq", key);

    const setSafeMode = (mode: boolean) => {
        setSafeModeState(mode);
        localStorage.setItem("safe_mode", String(mode));
    };

    const setDebugLogsEnabled = (enabled: boolean) => {
        setDebugLogsEnabledState(enabled);
        localStorage.setItem(DEBUG_LOGS_STORAGE_KEY, String(enabled));
    };

    const setThemeMetadata = (theme: ThemeMetadata) => {
        setThemeMetadataState(theme);
        localStorage.setItem("theme_metadata", JSON.stringify(theme));
    }

    return (
        <SettingsContext.Provider value={{
            apiKey: apiKeys.groq || null,
            setApiKey,
            apiKeys,
            setProviderKey,
            serverConfiguredKeys,
            safeMode,
            setSafeMode,
            debugLogsEnabled,
            setDebugLogsEnabled,
            themeMetadata,
            setThemeMetadata
        }}>
            {children}
        </SettingsContext.Provider>
    );
}

export function useSettings() {
    const context = useContext(SettingsContext);
    if (context === undefined) {
        throw new Error("useSettings must be used within a SettingsProvider");
    }
    return context;
}
