"use client";

import { useState } from "react";
import { AgentConfig } from "@/lib/core/Agent";
import {
    SquadConfig,
    SquadInteractionMode,
    getSquadInteractionConfig,
    normalizeSquadConfig,
} from "@/lib/core/Squad";
import { Save, Users, X, LayoutGrid, MessageSquare, ListTree, Volume2, Keyboard } from "lucide-react";

interface SquadEditorProps {
    initialData?: SquadConfig;
    availableAgents: AgentConfig[];
    onSave: (squad: SquadConfig) => void;
    onCancel: () => void;
}

function createDefaultSquad(): SquadConfig {
    return normalizeSquadConfig({
        name: "",
        mission: "",
        directorId: "",
        members: [],
    });
}

export function SquadEditor({
    initialData,
    availableAgents,
    onSave,
    onCancel,
}: SquadEditorProps) {
    const [formData, setFormData] = useState<SquadConfig>(() => (
        initialData ? normalizeSquadConfig(initialData) : createDefaultSquad()
    ));

    const interaction = getSquadInteractionConfig(formData);

    const toggleMember = (agentId: string) => {
        if (agentId === formData.directorId) return;
        setFormData((prev) => {
            const current = prev.members || [];
            if (current.includes(agentId)) {
                return { ...prev, members: current.filter((id) => id !== agentId) };
            }
            return { ...prev, members: [...current, agentId] };
        });
    };

    const updateInteraction = (patch: Partial<ReturnType<typeof getSquadInteractionConfig>>) => {
        setFormData((prev) => ({
            ...prev,
            interaction: {
                ...getSquadInteractionConfig(prev),
                ...patch,
            },
        }));
    };

    const selectInteractionMode = (mode: SquadInteractionMode) => {
        setFormData((prev) => ({
            ...prev,
            interaction: getSquadInteractionConfig({
                ...prev,
                interaction: { mode },
            }),
        }));
    };

    const canSave =
        formData.name.trim().length > 0 &&
        formData.mission.trim().length > 0 &&
        formData.directorId.trim().length > 0 &&
        formData.members.length > 0;

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden flex flex-col h-full max-w-3xl mx-auto mt-6">
            <div className="bg-slate-800/80 p-6 flex justify-between items-center border-b border-slate-700">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <LayoutGrid className="text-purple-500" />
                    {initialData ? "Reorganize Squad" : "Create Squad"}
                </h2>
                <button onClick={onCancel} className="text-slate-400 hover:text-white transition-colors">
                    <X />
                </button>
            </div>

            <div className="p-8 space-y-7 overflow-y-auto flex-1">
                <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-300">Squad Name</label>
                    <input
                        type="text"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all placeholder:text-slate-600"
                        placeholder="e.g. Campaign Party"
                    />
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-300">Mission</label>
                    <textarea
                        value={formData.mission}
                        onChange={(e) => setFormData({ ...formData, mission: e.target.value })}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all h-24 resize-none placeholder:text-slate-600"
                        placeholder="Define this squad objective (e.g., run a fantasy campaign where each agent plays a character)."
                    />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-300">Director (Master)</label>
                        <select
                            value={formData.directorId}
                            onChange={(e) =>
                                setFormData((prev) => ({
                                    ...prev,
                                    directorId: e.target.value,
                                    members: prev.members.filter((id) => id !== e.target.value),
                                }))
                            }
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 appearance-none"
                        >
                            <option value="" disabled>Select a Director...</option>
                            {availableAgents.map((agent) => (
                                <option key={agent.id} value={agent.id}>{agent.name} - {agent.role}</option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-300">Max Iterations</label>
                        <input
                            type="number"
                            min={1}
                            max={20}
                            value={formData.maxIterations ?? 6}
                            onChange={(e) => {
                                const parsed = Number.parseInt(e.target.value, 10);
                                setFormData((prev) => ({
                                    ...prev,
                                    maxIterations: Number.isFinite(parsed) ? Math.max(1, Math.min(20, parsed)) : 6,
                                }));
                            }}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all"
                        />
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                        <Users size={16} className="text-blue-400" />
                        Team Members
                    </label>
                    <div className="grid grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-2">
                        {availableAgents.map((agent) => {
                            const id = agent.id || "";
                            const isSelected = formData.members.includes(id);
                            const isDirector = formData.directorId === id;

                            if (isDirector) return null;

                            return (
                                <div
                                    key={id}
                                    onClick={() => toggleMember(id)}
                                    className={`p-3 rounded-lg border cursor-pointer flex items-center gap-3 transition-all ${
                                        isSelected
                                            ? "bg-purple-500/10 border-purple-500/50"
                                            : "bg-slate-950 border-slate-800 hover:border-slate-700"
                                    }`}
                                >
                                    <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                        isSelected ? "bg-purple-500 border-purple-500" : "border-slate-700"
                                    }`}>
                                        {isSelected && <div className="w-2 h-2 bg-white rounded-sm" />}
                                    </div>
                                    <div>
                                        <div className={`text-sm font-medium ${isSelected ? "text-purple-100" : "text-slate-400"}`}>{agent.name}</div>
                                        <div className="text-[10px] text-slate-600">{agent.role}</div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <div>
                        <div className="text-sm font-semibold text-slate-200">Interaction Mode</div>
                        <div className="text-xs text-slate-500 mt-1">
                            Choose how this squad should present work: autonomous output or live multi-character play.
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <button
                            type="button"
                            onClick={() => selectInteractionMode("master_log")}
                            className={`text-left rounded-lg border p-3 transition-all ${
                                interaction.mode === "master_log"
                                    ? "border-purple-500/60 bg-purple-500/10 ring-1 ring-purple-500/40"
                                    : "border-slate-800 bg-slate-900 hover:border-slate-700"
                            }`}
                        >
                            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                <ListTree size={14} className="text-purple-300" />
                                Autonomous (Master Log)
                            </div>
                            <div className="text-xs text-slate-400 mt-1">
                                Workers operate in the background; users mainly see final answers.
                            </div>
                        </button>

                        <button
                            type="button"
                            onClick={() => selectInteractionMode("live_campaign")}
                            className={`text-left rounded-lg border p-3 transition-all ${
                                interaction.mode === "live_campaign"
                                    ? "border-blue-500/60 bg-blue-500/10 ring-1 ring-blue-500/40"
                                    : "border-slate-800 bg-slate-900 hover:border-slate-700"
                            }`}
                        >
                            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                <MessageSquare size={14} className="text-blue-300" />
                                Live Campaign
                            </div>
                            <div className="text-xs text-slate-400 mt-1">
                                Show each character in chat with turn-taking controls for user-driven sessions.
                            </div>
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                        <label className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5 flex items-start gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={interaction.showMasterLog}
                                onChange={(e) => updateInteraction({ showMasterLog: e.target.checked })}
                                className="mt-0.5 accent-purple-500"
                            />
                            <span>
                                <span className="text-xs font-semibold text-slate-200">Show Master Log panel</span>
                                <span className="block text-[11px] text-slate-500">Keep orchestration traces visible in a side panel.</span>
                            </span>
                        </label>

                        <label className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5 flex items-start gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={interaction.showAgentMessagesInChat}
                                onChange={(e) => updateInteraction({ showAgentMessagesInChat: e.target.checked })}
                                className="mt-0.5 accent-purple-500"
                            />
                            <span>
                                <span className="text-xs font-semibold text-slate-200">Show agent turns in chat</span>
                                <span className="block text-[11px] text-slate-500">Publish individual worker outputs as chat messages.</span>
                            </span>
                        </label>

                        <label className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5 flex items-start gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={interaction.includeDirectorMessagesInChat}
                                onChange={(e) => updateInteraction({ includeDirectorMessagesInChat: e.target.checked })}
                                className="mt-0.5 accent-purple-500"
                            />
                            <span>
                                <span className="text-xs font-semibold text-slate-200">Show director narration</span>
                                <span className="block text-[11px] text-slate-500">Include director decisions as in-chat narration messages.</span>
                            </span>
                        </label>

                        <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5">
                            <div className="text-xs font-semibold text-slate-200">User Turn Policy</div>
                            <div className="mt-2 grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => updateInteraction({ userTurnPolicy: "on_demand" })}
                                    className={`px-2 py-1.5 rounded text-[11px] border transition-all ${
                                        interaction.userTurnPolicy === "on_demand"
                                            ? "border-purple-500/60 bg-purple-500/15 text-purple-100"
                                            : "border-slate-700 text-slate-400 hover:text-slate-200"
                                    }`}
                                >
                                    On Demand
                                </button>
                                <button
                                    type="button"
                                    onClick={() => updateInteraction({ userTurnPolicy: "every_round" })}
                                    className={`px-2 py-1.5 rounded text-[11px] border transition-all ${
                                        interaction.userTurnPolicy === "every_round"
                                            ? "border-purple-500/60 bg-purple-500/15 text-purple-100"
                                            : "border-slate-700 text-slate-400 hover:text-slate-200"
                                    }`}
                                >
                                    Every Round
                                </button>
                            </div>
                            <div className="text-[11px] text-slate-500 mt-2">
                                Every Round pauses after one worker turn so the user can respond.
                            </div>
                        </div>

                        <label className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5 flex items-start gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={interaction.typewriterCharacterMessages}
                                onChange={(e) => updateInteraction({ typewriterCharacterMessages: e.target.checked })}
                                className="mt-0.5 accent-purple-500"
                            />
                            <span>
                                <span className="text-xs font-semibold text-slate-200 inline-flex items-center gap-1.5">
                                    <Keyboard size={12} />
                                    Character typewriter effect
                                </span>
                                <span className="block text-[11px] text-slate-500">Animate character text as it appears in chat.</span>
                            </span>
                        </label>

                        <label className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2.5 flex items-start gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={interaction.autoPlayCharacterVoices}
                                onChange={(e) => updateInteraction({ autoPlayCharacterVoices: e.target.checked })}
                                className="mt-0.5 accent-purple-500"
                            />
                            <span>
                                <span className="text-xs font-semibold text-slate-200 inline-flex items-center gap-1.5">
                                    <Volume2 size={12} />
                                    Auto-play character voices
                                </span>
                                <span className="block text-[11px] text-slate-500">Use each character voice automatically when their line appears.</span>
                            </span>
                        </label>
                    </div>
                </div>
            </div>

            <div className="p-6 bg-slate-800/50 border-t border-slate-700 flex justify-end gap-3">
                <button
                    onClick={onCancel}
                    className="px-5 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={() => onSave(normalizeSquadConfig(formData))}
                    disabled={!canSave}
                    className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold shadow-lg shadow-purple-500/20 transition-all active:scale-95"
                >
                    <Save size={16} /> Save Squad
                </button>
            </div>
        </div>
    );
}
