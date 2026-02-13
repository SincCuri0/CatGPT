"use client";

import { useMemo, useState } from "react";
import type { SquadBlueprintDefinition } from "@/lib/squads/blueprints";
import { BookTemplate, Download, FileJson, Import, Trash2, Users, X } from "lucide-react";

interface SquadBlueprintLibraryModalProps {
    isOpen: boolean;
    defaultBlueprints: SquadBlueprintDefinition[];
    savedBlueprints: SquadBlueprintDefinition[];
    availableProviderIds: string[];
    providerNameById: Record<string, string>;
    onClose: () => void;
    onImportBlueprint: (blueprint: SquadBlueprintDefinition) => void;
    onDeleteSavedBlueprint: (blueprintId: string) => void;
    onExportBlueprint: (blueprint: SquadBlueprintDefinition) => void;
    onImportJson: (jsonText: string) => { importedCount: number };
}

export function SquadBlueprintLibraryModal({
    isOpen,
    defaultBlueprints,
    savedBlueprints,
    availableProviderIds,
    providerNameById,
    onClose,
    onImportBlueprint,
    onDeleteSavedBlueprint,
    onExportBlueprint,
    onImportJson,
}: SquadBlueprintLibraryModalProps) {
    const [jsonInput, setJsonInput] = useState("");
    const [importError, setImportError] = useState<string | null>(null);
    const [importInfo, setImportInfo] = useState<string | null>(null);

    const sortedSavedBlueprints = useMemo(
        () => [...savedBlueprints].sort((a, b) => a.name.localeCompare(b.name)),
        [savedBlueprints],
    );

    if (!isOpen) return null;

    const handleImportJson = () => {
        setImportError(null);
        setImportInfo(null);

        try {
            const result = onImportJson(jsonInput);
            setImportInfo(`Imported ${result.importedCount} blueprint${result.importedCount === 1 ? "" : "s"} into your squads.`);
            setJsonInput("");
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to import blueprint JSON.";
            setImportError(message);
        }
    };

    const renderBlueprintCard = (blueprint: SquadBlueprintDefinition, isSaved: boolean) => (
        <div key={blueprint.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-100 truncate">{blueprint.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{blueprint.category}</div>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-slate-500">
                    <Users size={12} />
                    <span>{blueprint.agents.length}</span>
                </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">{blueprint.description}</p>

            {blueprint.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {blueprint.tags.slice(0, 5).map((tag) => (
                        <span
                            key={tag}
                            className="text-[10px] px-2 py-0.5 rounded-full border border-slate-700 text-slate-400"
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            )}
            {(() => {
                const orchestratorProvider = (blueprint.squad.orchestrator?.provider || "").trim().toLowerCase();
                const workerProviders = blueprint.agents
                    .map((agent) => (agent.provider || "").trim().toLowerCase())
                    .filter((provider) => provider.length > 0);
                const providerIds = Array.from(new Set([
                    ...workerProviders,
                    ...(orchestratorProvider ? [orchestratorProvider] : []),
                ]));

                if (providerIds.length === 0) return null;

                const unavailableCount = providerIds.filter((providerId) => !availableProviderIds.includes(providerId)).length;
                return (
                    <div className="space-y-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            APIs
                        </div>
                        <div className="flex flex-wrap gap-1">
                            {providerIds.map((providerId) => {
                                const available = availableProviderIds.includes(providerId);
                                const label = providerNameById[providerId] || providerId;
                                return (
                                    <span
                                        key={`${blueprint.id}-${providerId}`}
                                        className={`text-[10px] px-2 py-0.5 rounded-full border ${
                                            available
                                                ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                                                : "border-amber-500/40 text-amber-300 bg-amber-500/10"
                                        }`}
                                    >
                                        {label}
                                    </span>
                                );
                            })}
                        </div>
                        {unavailableCount > 0 && (
                            <div className="text-[10px] text-amber-300">
                                Missing key for {unavailableCount} provider{unavailableCount === 1 ? "" : "s"}.
                                Import will auto-map to available models.
                            </div>
                        )}
                    </div>
                );
            })()}

            <div className="flex items-center gap-2 pt-1">
                <button
                    type="button"
                    onClick={() => onImportBlueprint(blueprint)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                >
                    <Import size={12} />
                    Import Squad
                </button>
                <button
                    type="button"
                    onClick={() => onExportBlueprint(blueprint)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 transition-colors"
                >
                    <Download size={12} />
                    Export JSON
                </button>
                {isSaved && (
                    <button
                        type="button"
                        onClick={() => onDeleteSavedBlueprint(blueprint.id)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 transition-colors"
                    >
                        <Trash2 size={12} />
                        Remove
                    </button>
                )}
            </div>
        </div>
    );

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[80] flex items-center justify-center p-4">
            <div className="w-full max-w-5xl h-[85vh] max-h-[85vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
                <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-bold text-white inline-flex items-center gap-2">
                            <BookTemplate size={18} className="text-amber-300" />
                            Squad Blueprints
                        </h2>
                        <p className="text-xs text-slate-500 mt-1">
                            Import defaults, save your own templates, or load JSON shared by other users.
                        </p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
                        <X />
                    </button>
                </div>

                <div className="p-4 overflow-y-auto custom-scrollbar flex-1 space-y-5">
                    <section className="space-y-2">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-slate-200">Default Blueprints</h3>
                            <span className="text-[11px] text-slate-500">{defaultBlueprints.length}</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {defaultBlueprints.map((blueprint) => renderBlueprintCard(blueprint, false))}
                        </div>
                    </section>

                    <section className="space-y-2">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-slate-200">Saved Blueprints</h3>
                            <span className="text-[11px] text-slate-500">{sortedSavedBlueprints.length}</span>
                        </div>
                        {sortedSavedBlueprints.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950 px-3 py-4 text-center text-xs text-slate-500">
                                No saved blueprints yet. Save one from a squad menu.
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {sortedSavedBlueprints.map((blueprint) => renderBlueprintCard(blueprint, true))}
                            </div>
                        )}
                    </section>

                    <section className="space-y-2">
                        <h3 className="text-sm font-semibold text-slate-200 inline-flex items-center gap-2">
                            <FileJson size={14} className="text-blue-300" />
                            Import Blueprint JSON
                        </h3>
                        <textarea
                            value={jsonInput}
                            onChange={(event) => setJsonInput(event.target.value)}
                            className="w-full h-36 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all placeholder:text-slate-600"
                            placeholder="Paste JSON exported from Squad Blueprints."
                        />
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-[11px] text-slate-500">
                                Supports single blueprint payloads and multi-blueprint bundles.
                            </div>
                            <button
                                type="button"
                                onClick={handleImportJson}
                                disabled={jsonInput.trim().length === 0}
                                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <Import size={12} />
                                Import JSON
                            </button>
                        </div>
                        {importError && (
                            <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md px-2.5 py-2">
                                {importError}
                            </div>
                        )}
                        {importInfo && (
                            <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-2.5 py-2">
                                {importInfo}
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
