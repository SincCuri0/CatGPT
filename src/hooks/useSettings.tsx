"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { DEBUG_LOGS_STORAGE_KEY } from "@/lib/debug/constants";

interface SettingsContextType {
    apiKeys: Record<string, string>;
    setProviderKey: (providerId: string, key: string) => void;
    serverConfiguredKeys: Record<string, boolean>;
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

    return localKeys;
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
    const [apiKeys, setApiKeysState] = useState<Record<string, string>>(() => getInitialApiKeys());
    const [serverConfiguredKeys, setServerConfiguredKeys] = useState<Record<string, boolean>>({});
    const [debugLogsEnabled, setDebugLogsEnabledState] = useState<boolean>(false);
    const [themeMetadata, setThemeMetadataState] = useState<ThemeMetadata>(() => getInitialTheme());

    useEffect(() => {
        setDebugLogsEnabledState(localStorage.getItem(DEBUG_LOGS_STORAGE_KEY) === "true");
    }, []);

    useEffect(() => {
        fetch("/api/settings", {
            headers: debugLogsEnabled ? { "x-debug-logs": "1" } : undefined,
        })
            .then((res) => res.json())
            .then(data => {
                if (data.keysConfigured) {
                    setServerConfiguredKeys(data.keysConfigured);
                }
            })
            .catch((error) => console.error("Settings sync failed", error));
    }, [debugLogsEnabled]);

    const setProviderKey = async (providerId: string, key: string) => {
        const newKeys = { ...apiKeys, [providerId]: key };
        if (!key) delete newKeys[providerId];

        setApiKeysState(newKeys);
        localStorage.setItem("cat_gpt_api_keys", JSON.stringify(newKeys));

        try {
            await fetch("/api/settings", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(debugLogsEnabled ? { "x-debug-logs": "1" } : {}),
                },
                body: JSON.stringify({ apiKeys: { [providerId]: key } }),
            });
        } catch (error) {
            console.error("Failed to persist API key to server", error);
        }
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
            apiKeys,
            setProviderKey,
            serverConfiguredKeys,
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
