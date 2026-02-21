"use client";

import { useSettings } from "@/hooks/useSettings";
import { useCallback, useEffect, useState } from "react";
import { X, Key, Save, Cat, ExternalLink, Check, Bug, Server, FileJson, Upload } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { PROVIDERS } from "@/lib/llm/constants";

const API_KEY_PROVIDERS = [
    ...PROVIDERS.map((provider) => ({ ...provider, envVar: provider.id === "google" ? "GEMINI_API_KEY" : `${provider.id.toUpperCase()}_API_KEY` })),
    {
        id: "elevenlabs",
        name: "ElevenLabs",
        description: "TTS provider",
        defaultModel: "",
        models: [],
        requiresApiKey: true,
        apiKeyLink: "https://elevenlabs.io/app/settings/api-keys",
        envVar: "ELEVENLABS_API_KEY",
    },
];
const RUNTIME_TOKEN_STORAGE_KEY = "cat_gpt_runtime_admin_token";

interface McpServiceSummary {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    command: string;
    args: string[];
    status: "disabled" | "idle" | "connecting" | "ready" | "error";
    error?: string;
    toolCount: number;
}

function getStatusBadge(status: McpServiceSummary["status"]): { label: string; className: string } {
    if (status === "ready") {
        return { label: "Ready", className: "bg-[#9ece6a]/10 text-[#9ece6a] border-[#9ece6a]/30" };
    }
    if (status === "connecting") {
        return { label: "Starting", className: "bg-[#e0af68]/10 text-[#e0af68] border-[#e0af68]/30" };
    }
    if (status === "idle") {
        return { label: "Idle", className: "bg-[#7dcfff]/10 text-[#7dcfff] border-[#7dcfff]/30" };
    }
    if (status === "disabled") {
        return { label: "Disabled", className: "bg-[#565f89]/10 text-[#565f89] border-[#565f89]/30" };
    }
    return { label: "Error", className: "bg-[#f7768e]/10 text-[#f7768e] border-[#f7768e]/30" };
}

export function SettingsModal({ isOpen, onClose, onOpenImport }: { isOpen: boolean; onClose: () => void; onOpenImport: () => void }) {
    const {
        apiKeys,
        setProviderKey,
        serverConfiguredKeys,
        debugLogsEnabled,
        setDebugLogsEnabled,
    } = useSettings();
    const [tempKeys, setTempKeys] = useState<Record<string, string> | null>(null);
    const [mcpServices, setMcpServices] = useState<McpServiceSummary[]>([]);
    const [isLoadingMcpServices, setIsLoadingMcpServices] = useState(false);
    const [mcpServicesError, setMcpServicesError] = useState<string | null>(null);
    const [runtimeAdminToken, setRuntimeAdminToken] = useState("");
    const effectiveKeys = tempKeys ?? apiKeys;

    const loadMcpServices = useCallback(async () => {
        setIsLoadingMcpServices(true);
        setMcpServicesError(null);
        try {
            const response = await fetch("/api/mcp/services", {
                headers: debugLogsEnabled ? { "x-debug-logs": "1" } : undefined,
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || `Failed to load MCP services (${response.status})`);
            }
            const services = Array.isArray(data.services) ? data.services : [];
            setMcpServices(services);
        } catch (error: unknown) {
            setMcpServicesError(error instanceof Error ? error.message : "Failed to load MCP services.");
        } finally {
            setIsLoadingMcpServices(false);
        }
    }, [debugLogsEnabled]);

    useEffect(() => {
        if (!isOpen) return;
        void loadMcpServices();
        try {
            const storedToken = localStorage.getItem(RUNTIME_TOKEN_STORAGE_KEY) || "";
            setRuntimeAdminToken(storedToken);
        } catch {
            setRuntimeAdminToken("");
        }
    }, [isOpen, loadMcpServices]);

    const handleKeyChange = (providerId: string, key: string) => {
        setTempKeys((prev) => ({
            ...(prev ?? apiKeys),
            [providerId]: key,
        }));
    };

    const handleClose = () => {
        setTempKeys(null);
        onClose();
    };

    const handleSave = () => {
        try {
            const trimmedRuntimeToken = runtimeAdminToken.trim();
            if (trimmedRuntimeToken) {
                localStorage.setItem(RUNTIME_TOKEN_STORAGE_KEY, trimmedRuntimeToken);
            } else {
                localStorage.removeItem(RUNTIME_TOKEN_STORAGE_KEY);
            }
        } catch {
            // Ignore localStorage write failures.
        }
        // Save all changed keys
        Object.entries(effectiveKeys).forEach(([provider, key]) => {
            setProviderKey(provider, key);
        });
        setTempKeys(null);
        onClose();
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-4"
                >
                    <motion.div
                        initial={{ scale: 0.9, opacity: 0, rotate: -2 }}
                        animate={{ scale: 1, opacity: 1, rotate: 0 }}
                        exit={{ scale: 0.9, opacity: 0 }}
                        className="bg-[#1a1b26] border border-[#ff9e64]/30 p-8 rounded-3xl shadow-2xl w-full max-w-lg ring-4 ring-[#ff9e64]/5 relative overflow-hidden max-h-[90vh] flex flex-col"
                    >
                        {/* Decor */}
                        <div className="absolute top-0 right-0 w-32 h-32 bg-[#ff9e64]/5 rounded-bl-full -mr-10 -mt-10" />

                        <div className="flex justify-between items-center mb-6 relative z-10 flex-shrink-0">
                            <div>
                                <h2 className="text-2xl font-bold flex items-center gap-3 text-white">
                                    <Cat className="text-[#ff9e64]" />
                                    Litter Box Config
                                </h2>
                                <p className="text-[#565f89] text-sm mt-1 font-medium">Tweak the environment.</p>
                            </div>
                            <button
                                onClick={handleClose}
                                className="p-2 hover:bg-[#24283b] rounded-full transition-colors text-[#565f89] hover:text-[#f7768e]"
                            >
                                <X className="w-6 h-6" />
                            </button>
                        </div>

                        <div className="space-y-6 relative z-10 overflow-y-auto pr-2 custom-scrollbar flex-1">
                            {/* API Keys Section */}
                            <div className="space-y-4">
                                <h3 className="text-sm font-bold text-[#c0caf5] uppercase tracking-wider">API Providers</h3>

                                {API_KEY_PROVIDERS.map(provider => {
                                    const isServerSet = serverConfiguredKeys[provider.envVar];

                                    return (
                                        <div key={provider.id} className="space-y-2">
                                            <div className="flex justify-between items-center">
                                                <label className="text-xs font-semibold text-[#a9b1d6] flex items-center gap-2">
                                                    {provider.name}
                                                    {isServerSet && (
                                                        <span className="text-[10px] bg-[#9ece6a]/10 text-[#9ece6a] px-1.5 py-0.5 rounded flex items-center gap-1">
                                                            <Check size={10} /> Env Configured
                                                        </span>
                                                    )}
                                                </label>
                                                {provider.apiKeyLink && (
                                                    <a
                                                        href={provider.apiKeyLink}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-[10px] text-[#ff9e64] hover:underline flex items-center gap-1"
                                                    >
                                                        Get Key <ExternalLink size={10} />
                                                    </a>
                                                )}
                                            </div>
                                            <div className="relative group">
                                                <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#565f89] group-focus-within:text-[#ff9e64] transition-colors" />
                                                <input
                                                    type="password"
                                                    value={effectiveKeys[provider.id] || ""}
                                                    onChange={(e) => handleKeyChange(provider.id, e.target.value)}
                                                    placeholder={isServerSet ? "Managed by System (Optional override)" : `${provider.name} API Key`}
                                                    className={`w-full bg-[#16161e] border ${isServerSet && !effectiveKeys[provider.id] ? "border-[#9ece6a]/30" : "border-[#414868]"} rounded-xl pl-10 pr-4 py-3 text-white focus:outline-none focus:border-[#ff9e64] focus:ring-1 focus:ring-[#ff9e64] transition-all placeholder:text-[#565f89] text-sm`}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* MCP Services Section */}
                            <div className="bg-[#24283b] rounded-2xl p-5 border border-[#414868]">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2 text-sm font-bold text-[#c0caf5]">
                                        <Server className="w-4 h-4 text-[#7dcfff]" />
                                        Local MCP Services
                                    </div>
                                    <button
                                        onClick={() => void loadMcpServices()}
                                        disabled={isLoadingMcpServices}
                                        className="px-2 py-1 text-[10px] font-semibold rounded-md border border-[#414868] text-[#a9b1d6] hover:bg-[#1f2335] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                    >
                                        {isLoadingMcpServices ? "Loading..." : "Refresh"}
                                    </button>
                                </div>
                                <p className="text-[11px] text-[#787c99] mb-3">
                                    These MCP servers are launched locally by CatGPT and exposed as tools via the `mcp_all` capability.
                                </p>

                                {mcpServicesError && (
                                    <div className="text-[11px] text-[#f7768e] bg-[#f7768e]/10 border border-[#f7768e]/30 rounded-lg px-2.5 py-2 mb-2">
                                        {mcpServicesError}
                                    </div>
                                )}

                                {mcpServices.length === 0 && !isLoadingMcpServices && !mcpServicesError && (
                                    <div className="text-[11px] text-[#787c99] bg-[#1f2335] border border-[#414868] rounded-lg px-2.5 py-2">
                                        No MCP services configured.
                                    </div>
                                )}

                                <div className="space-y-2 max-h-44 overflow-y-auto pr-1 custom-scrollbar">
                                    {mcpServices.map((service) => {
                                        const badge = getStatusBadge(service.status);
                                        return (
                                            <div
                                                key={service.id}
                                                className="rounded-lg border border-[#414868] bg-[#1f2335] px-3 py-2.5"
                                            >
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="min-w-0">
                                                        <div className="text-xs font-semibold text-[#c0caf5] truncate">
                                                            {service.name}
                                                        </div>
                                                        <div className="text-[10px] text-[#565f89] truncate">
                                                            {service.id}
                                                        </div>
                                                    </div>
                                                    <span className={`text-[10px] px-2 py-0.5 border rounded-full ${badge.className}`}>
                                                        {badge.label}
                                                    </span>
                                                </div>
                                                <div className="text-[10px] text-[#787c99] mt-1.5 break-all">
                                                    {service.command} {service.args.join(" ")}
                                                </div>
                                                <div className="text-[10px] text-[#a9b1d6] mt-1">
                                                    Tools: {service.toolCount} {service.enabled ? "" : "(disabled)"}
                                                </div>
                                                {service.error && (
                                                    <div className="text-[10px] text-[#f7768e] mt-1 break-words">
                                                        {service.error}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Debug Logs Section */}
                            <div className="bg-[#24283b] rounded-2xl p-5 border border-[#414868]">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="flex items-center gap-2 text-sm font-bold text-[#c0caf5]">
                                        <Bug className={`w-4 h-4 ${debugLogsEnabled ? "text-[#7dcfff]" : "text-[#565f89]"}`} />
                                        Console Debug Logs
                                    </span>
                                    <button
                                        onClick={() => setDebugLogsEnabled(!debugLogsEnabled)}
                                        className={`relative w-12 h-7 rounded-full transition-colors ${debugLogsEnabled ? "bg-[#7dcfff]" : "bg-[#414868]"
                                            }`}
                                    >
                                        <div
                                            className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all shadow-md ${debugLogsEnabled ? "left-6" : "left-1"
                                                }`}
                                        />
                                    </button>
                                </div>
                                <p className="text-xs text-[#787c99] leading-relaxed">
                                    {debugLogsEnabled
                                        ? "Enabled. API routes print debug details to the console."
                                        : "Disabled. API debug logging is muted unless explicitly enabled."}
                                </p>
                            </div>

                            {/* Data Management Section */}
                            <div className="bg-[#24283b] rounded-2xl p-5 border border-[#414868]">
                                <div className="flex items-center gap-2 mb-2 text-sm font-bold text-[#c0caf5]">
                                    <FileJson className="w-4 h-4 text-[#7aa2f7]" />
                                    Data Management
                                </div>
                                <p className="text-xs text-[#787c99] leading-relaxed mb-3">
                                    Manage your local conversation data.
                                </p>
                                <button
                                    onClick={onOpenImport}
                                    className="w-full flex items-center justify-center gap-2 bg-[#1f2335] hover:bg-[#292e42] border border-[#414868] text-white text-xs font-semibold py-2.5 rounded-xl transition-all"
                                >
                                    <Upload className="w-3 h-3" />
                                    Import from ChatGPT Export
                                </button>
                            </div>

                            {/* Runtime Token Section */}
                            <div className="bg-[#24283b] rounded-2xl p-5 border border-[#414868]">
                                <div className="flex items-center gap-2 mb-2 text-sm font-bold text-[#c0caf5]">
                                    <Key className="w-4 h-4 text-[#bb9af7]" />
                                    Runtime Admin Token
                                </div>
                                <p className="text-xs text-[#787c99] leading-relaxed mb-3">
                                    Optional token sent to runtime ops endpoints (`/api/runtime/*`). Needed in production when `RUNTIME_ADMIN_TOKEN` is configured.
                                </p>
                                <input
                                    type="password"
                                    value={runtimeAdminToken}
                                    onChange={(event) => setRuntimeAdminToken(event.target.value)}
                                    placeholder="Runtime admin token (optional)"
                                    className="w-full bg-[#16161e] border border-[#414868] rounded-xl px-3 py-2.5 text-white focus:outline-none focus:border-[#bb9af7] focus:ring-1 focus:ring-[#bb9af7] transition-all placeholder:text-[#565f89] text-sm"
                                />
                            </div>
                        </div>

                        <div className="pt-6 flex justify-end gap-3 flex-shrink-0 mt-auto border-t border-[#414868]/50">
                            <button
                                onClick={handleClose}
                                className="px-6 py-3 text-sm font-bold text-[#787c99] hover:text-white hover:bg-[#24283b] rounded-xl transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                className="flex items-center gap-2 px-6 py-3 text-sm font-bold bg-[#ff9e64] text-[#1a1b26] rounded-xl hover:bg-[#ffb86c] transition-all shadow-lg shadow-[#ff9e64]/20 hover:scale-105 active:scale-95"
                            >
                                <Save className="w-4 h-4" />
                                Save Changes
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
