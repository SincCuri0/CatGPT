"use client";

import { createContext, useContext, useEffect, useState } from "react";

interface SettingsContextType {
    apiKey: string | null;
    setApiKey: (key: string) => void;
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
    const [apiKey, setApiKeyState] = useState<string | null>(null);
    const [safeMode, setSafeModeState] = useState<boolean>(true);
    const [themeMetadata, setThemeMetadataState] = useState<ThemeMetadata>({ id: 'modern', name: 'Sleek Synergy' });

    useEffect(() => {
        // Load from localStorage on mount
        const storedKey = localStorage.getItem("groq_api_key");
        if (storedKey) setApiKeyState(storedKey);

        // Sync with Server .env
        fetch('/api/settings')
            .then(res => res.json())
            .then(data => {
                if (data.apiKey) {
                    if (!storedKey || storedKey !== data.apiKey) {
                        setApiKeyState(data.apiKey);
                        localStorage.setItem("groq_api_key", data.apiKey);
                    }
                }
            })
            .catch(e => console.error("Settings sync failed", e));

        const storedSafeMode = localStorage.getItem("safe_mode");
        if (storedSafeMode) setSafeModeState(storedSafeMode === "true");

        // Default safe mode to true if not set
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

    const setApiKey = async (key: string) => {
        setApiKeyState(key);
        if (key) {
            localStorage.setItem("groq_api_key", key);
            try {
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey: key })
                });
            } catch (e) {
                console.error("Failed to persist API Key", e);
            }
        } else {
            localStorage.removeItem("groq_api_key");
        }
    };

    const setSafeMode = (mode: boolean) => {
        setSafeModeState(mode);
        localStorage.setItem("safe_mode", String(mode));
    };

    const setThemeMetadata = (theme: ThemeMetadata) => {
        setThemeMetadataState(theme);
        localStorage.setItem("theme_metadata", JSON.stringify(theme));
    }

    return (
        <SettingsContext.Provider value={{ apiKey, setApiKey, safeMode, setSafeMode, themeMetadata, setThemeMetadata }}>
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
