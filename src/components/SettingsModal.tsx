"use client";

import { useSettings } from "@/hooks/useSettings";
import { useState } from "react";
import { X, Shield, ShieldAlert, Key, Save, Cat } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export function SettingsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const { apiKey, setApiKey, safeMode, setSafeMode } = useSettings();
    const [tempKey, setTempKey] = useState(apiKey || "");

    const handleSave = () => {
        setApiKey(tempKey);
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
                        className="bg-[#1a1b26] border border-[#ff9e64]/30 p-8 rounded-3xl shadow-2xl w-full max-w-md ring-4 ring-[#ff9e64]/5 relative overflow-hidden"
                    >
                        {/* Decor */}
                        <div className="absolute top-0 right-0 w-32 h-32 bg-[#ff9e64]/5 rounded-bl-full -mr-10 -mt-10" />

                        <div className="flex justify-between items-center mb-8 relative z-10">
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

                        <div className="space-y-8 relative z-10">
                            {/* API Key Section */}
                            <div className="space-y-3">
                                <label className="block text-sm font-bold text-[#c0caf5]">
                                    Cat Treats (API Key)
                                </label>
                                <div className="relative group">
                                    <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#565f89] group-focus-within:text-[#ff9e64] transition-colors" />
                                    <input
                                        type="password"
                                        value={tempKey}
                                        onChange={(e) => setTempKey(e.target.value)}
                                        placeholder="gsk_..."
                                        className="w-full bg-[#16161e] border border-[#414868] rounded-xl pl-10 pr-4 py-3.5 text-white focus:outline-none focus:border-[#ff9e64] focus:ring-1 focus:ring-[#ff9e64] transition-all placeholder:text-[#565f89]"
                                    />
                                </div>
                                <p className="text-xs text-[#565f89]">
                                    Necessary for buying virtual tuna (inference).
                                </p>
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

                            <div className="pt-4 flex justify-end gap-3">
                                <button
                                    onClick={onClose}
                                    className="px-6 py-3 text-sm font-bold text-[#787c99] hover:text-white hover:bg-[#24283b] rounded-xl transition-colors"
                                >
                                    Ignore
                                </button>
                                <button
                                    onClick={handleSave}
                                    className="flex items-center gap-2 px-6 py-3 text-sm font-bold bg-[#ff9e64] text-[#1a1b26] rounded-xl hover:bg-[#ffb86c] transition-all shadow-lg shadow-[#ff9e64]/20 hover:scale-105 active:scale-95"
                                >
                                    <Save className="w-4 h-4" />
                                    Save Changes
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
