"use client";

import { useSettings } from "@/hooks/useSettings";
import { useState, useEffect } from "react";
import { X, Shield, ShieldAlert, Key, Save, Cat, ExternalLink, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { PROVIDERS } from "@/lib/llm/constants";

export function SettingsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { apiKeys, setProviderKey, serverConfiguredKeys, safeMode, setSafeMode } = useSettings();
    const [tempKeys, setTempKeys] = useState<Record<string, string>>({});

    useEffect(() => {
        if (isOpen) {
            setTempKeys(apiKeys);
        }
    }, [isOpen, apiKeys]);

    const handleSave = () => {
        // Save all changed keys
        Object.entries(tempKeys).forEach(([provider, key]) => {
            setProviderKey(provider, key);
        });
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
                                onClick={onClose}
                                className="p-2 hover:bg-[#24283b] rounded-full transition-colors text-[#565f89] hover:text-[#f7768e]"
                            >
                                <X className="w-6 h-6" />
                            </button>
                        </div>

                        <div className="space-y-6 relative z-10 overflow-y-auto pr-2 custom-scrollbar flex-1">
                            {/* API Keys Section */}
                            <div className="space-y-4">
                                <h3 className="text-sm font-bold text-[#c0caf5] uppercase tracking-wider">API Providers</h3>

                                {PROVIDERS.map(provider => {
                                    const isEnvConfigured = serverConfiguredKeys[provider.id + "_API_KEY".toUpperCase()] || serverConfiguredKeys[provider.id.toUpperCase() + "_API_KEY"];
                                    // Actually the server returns specific key names, let's just check the map from getAllApiKeys
                                    // getAllApiKeys returns { GROQ_API_KEY: true, ... }
                                    // We need to map provider.id to env var name
                                    const envVarName = `${provider.id.toUpperCase()}_API_KEY`;
                                    const isServerSet = serverConfiguredKeys[envVarName];

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
                                                    value={tempKeys[provider.id] || ""}
                                                    onChange={(e) => setTempKeys({ ...tempKeys, [provider.id]: e.target.value })}
                                                    placeholder={isServerSet ? "Managed by System (Optional override)" : `${provider.name} API Key`}
                                                    className={`w-full bg-[#16161e] border ${isServerSet && !tempKeys[provider.id] ? "border-[#9ece6a]/30" : "border-[#414868]"} rounded-xl pl-10 pr-4 py-3 text-white focus:outline-none focus:border-[#ff9e64] focus:ring-1 focus:ring-[#ff9e64] transition-all placeholder:text-[#565f89] text-sm`}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Safe Mode Section */}
                            <div className="bg-[#24283b] rounded-2xl p-5 border border-[#414868]">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="flex items-center gap-2 text-sm font-bold text-[#c0caf5]">
                                        {safeMode ? <Shield className="w-4 h-4 text-[#9ece6a]" /> : <ShieldAlert className="w-4 h-4 text-[#e0af68]" />}
                                        Keyboard Sitting Protection
                                    </span>
                                    <button
                                        onClick={() => setSafeMode(!safeMode)}
                                        className={`relative w-12 h-7 rounded-full transition-colors ${safeMode ? "bg-[#9ece6a]" : "bg-[#414868]"
                                            }`}
                                    >
                                        <div
                                            className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all shadow-md ${safeMode ? "left-6" : "left-1"
                                                }`}
                                        />
                                    </button>
                                </div>
                                <p className="text-xs text-[#787c99] leading-relaxed">
                                    {safeMode
                                        ? "Safe. Prevents cats from running `rm -rf /` by walking on the keyboard."
                                        : "Dangerous. Cats have full shell access. Expect files to disappear."}
                                </p>
                            </div>
                        </div>

                        <div className="pt-6 flex justify-end gap-3 flex-shrink-0 mt-auto border-t border-[#414868]/50">
                            <button
                                onClick={onClose}
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
