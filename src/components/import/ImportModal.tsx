import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, FolderOpen, AlertCircle, RefreshCw } from "lucide-react";
import type { ExportScanResult } from "@/lib/import/chatgpt-types";
import { ImportFilterStep } from "./ImportFilterStep";

interface ImportModalProps {
    isOpen: boolean;
    onClose: () => void;
    onImportComplete: () => void;
}

type ImportState = "scanning" | "library" | "error" | "missing-folder";

export function ImportModal({ isOpen, onClose, onImportComplete }: ImportModalProps) {
    const [state, setState] = useState<ImportState>("scanning");
    const [scanResult, setScanResult] = useState<ExportScanResult | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Initial Scan
    useEffect(() => {
        if (isOpen) {
            scanLocalFolder();
        }
    }, [isOpen]);

    const scanLocalFolder = async () => {
        setState("scanning");
        setErrorMsg(null);
        try {
            const res = await fetch("/api/import/scan-local");
            if (res.status === 404) {
                setState("missing-folder");
                return;
            }
            if (!res.ok) throw new Error("Failed to scan folder");

            const data = await res.json();
            setScanResult(data);
            setState("library");
        } catch (err) {
            console.error(err);
            setErrorMsg("Failed to scan 'ChatGPT Export' folder.");
            setState("error");
        }
    };

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
                onClick={onClose}
            >
                <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.95, opacity: 0 }}
                    className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col h-[80vh]"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-neutral-800 bg-neutral-900/50">
                        <h2 className="text-lg font-semibold text-neutral-100 flex items-center gap-2">
                            <FolderOpen className="w-5 h-5 text-indigo-400" />
                            ChatGPT Library
                        </h2>
                        <div className="flex items-center gap-2">
                            {state === "library" && (
                                <button
                                    onClick={scanLocalFolder}
                                    className="p-1 hover:bg-neutral-800 rounded-full transition-colors text-neutral-400 hover:text-white"
                                    title="Rescan Folder"
                                >
                                    <RefreshCw className="w-5 h-5" />
                                </button>
                            )}
                            <button onClick={onClose} className="p-1 hover:bg-neutral-800 rounded-full transition-colors">
                                <X className="w-5 h-5 text-neutral-400" />
                            </button>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-hidden relative">
                        {state === "scanning" && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-center space-y-4">
                                <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
                                <div>
                                    <h3 className="text-lg font-medium text-neutral-200">Scanning Library...</h3>
                                    <p className="text-sm text-neutral-500">Looking for 'ChatGPT Export/conversations.json'</p>
                                </div>
                            </div>
                        )}

                        {state === "missing-folder" && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8 space-y-6">
                                <div className="w-20 h-20 bg-neutral-800 rounded-full flex items-center justify-center mx-auto">
                                    <FolderOpen className="w-10 h-10 text-neutral-500" />
                                </div>
                                <div className="max-w-md space-y-2">
                                    <h3 className="text-xl font-bold text-neutral-100">Folder Not Found</h3>
                                    <p className="text-neutral-400">
                                        Please create a folder named <code>ChatGPT Export</code> in the project root and place your <code>conversations.json</code> file inside it.
                                    </p>
                                </div>
                                <button
                                    onClick={scanLocalFolder}
                                    className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-lg font-medium text-white shadow-lg shadow-indigo-500/20 transition-all flex items-center gap-2"
                                >
                                    <RefreshCw className="w-4 h-4" />
                                    I've Created It, Try Again
                                </button>
                            </div>
                        )}

                        {state === "error" && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8 space-y-6">
                                <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mx-auto">
                                    <AlertCircle className="w-10 h-10 text-red-400" />
                                </div>
                                <div className="space-y-2">
                                    <h3 className="text-xl font-bold text-neutral-100">Access Error</h3>
                                    <p className="text-neutral-400 max-w-xs mx-auto">
                                        {errorMsg || "An unexpected error occurred."}
                                    </p>
                                </div>
                                <button
                                    onClick={scanLocalFolder}
                                    className="px-6 py-3 bg-neutral-800 hover:bg-neutral-700 rounded-lg font-medium text-white transition-all"
                                >
                                    Retry
                                </button>
                            </div>
                        )}

                        {state === "library" && scanResult && (
                            <ImportFilterStep
                                scanResult={scanResult}
                                onConfirm={() => { }} // Not used in library mode
                                onCancel={onClose}
                            />
                        )}
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
    return (
        <div className="bg-neutral-800/50 p-4 rounded-lg text-center border border-neutral-700/50">
            <div className="text-2xl font-bold text-neutral-100">{value}</div>
            <div className="text-xs text-neutral-500 uppercase tracking-wider mt-1">{label}</div>
        </div>
    );
}
