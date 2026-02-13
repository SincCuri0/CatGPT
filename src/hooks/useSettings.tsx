"use client";

import { createContext, useContext, useEffect, useState } from "react";

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
    themeMetadata: ThemeMetadata;
    setThemeMetadata: (theme: ThemeMetadata) => void;
}

interface ThemeMetadata {
    id: string;
    name: string;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
    // apiKeys: contains local keys (users enter these)
    const [apiKeys, setApiKeysState] = useState<Record<string, string>>({});
    // serverConfiguredKeys: which keys are set on server (.env)
    const [serverConfiguredKeys, setServerConfiguredKeys] = useState<Record<string, boolean>>({});

    const [safeMode, setSafeModeState] = useState<boolean>(true);
    const [themeMetadata, setThemeMetadataState] = useState<ThemeMetadata>({ id: 'modern', name: 'Sleek Synergy' });

    useEffect(() => {
        // 1. Load local keys from localStorage
        const storedKeysStr = localStorage.getItem("cat_gpt_api_keys");
        let localKeys: Record<string, string> = {};
        if (storedKeysStr) {
            try {
                localKeys = JSON.parse(storedKeysStr);
            } catch { /* ignore */ }
        }

        // Backward compat: check old key
        const oldGroqKey = localStorage.getItem("groq_api_key");
        if (oldGroqKey && !localKeys.groq) {
            localKeys.groq = oldGroqKey;
        }

        setApiKeysState(localKeys);

        // 2. Fetch server config status
        fetch('/api/settings')
            .then(res => res.json())
            .then(data => {
                if (data.keysConfigured) {
                    setServerConfiguredKeys(data.keysConfigured);
                }
                // Optional: Sync legacy logic if needed, but 'keysConfigured' is enough for UI
            })
            .catch(e => console.error("Settings sync failed", e));

        const storedSafeMode = localStorage.getItem("safe_mode");
        if (storedSafeMode) setSafeModeState(storedSafeMode === "true");
        if (storedSafeMode === null) setSafeModeState(true);

        const storedTheme = localStorage.getItem("theme_metadata");
        if (storedTheme) {
            try {
                setThemeMetadataState(JSON.parse(storedTheme));
            } catch (e) {
                console.error("Failed to parse theme metadata", e);
            }
        }
    }, []);

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
                headers: { 'Content-Type': 'application/json' },
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
