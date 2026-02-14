"use client";

import { useState } from "react";
import { AccessPermissionMode, AgentConfig } from "@/lib/core/Agent";
import {
    SquadConfig,
    SquadInteractionMode,
    getSquadGoal,
    getSquadInteractionConfig,
    normalizeSquadConfig,
} from "@/lib/core/Squad";
import { AgentEditor } from "@/components/agent/AgentEditor";
import { Save, Users, X, LayoutGrid, MessageSquare, ListTree, Sparkles, Pencil, Trash2, Loader2 } from "lucide-react";

interface SquadEditorProps {
    initialData?: SquadConfig;
    availableAgents: AgentConfig[];
    onCreateSquadAgents: (prompt: string) => Promise<{ createdAgents: AgentConfig[]; message: string }>;
    onUpsertSquadAgent: (agent: AgentConfig) => void;
    onDeleteSquadAgent: (agentId: string) => void;
    onSave: (squad: SquadConfig) => void;
    onCancel: () => void;
}

const ACCESS_PERMISSION_OPTIONS: Array<{
    id: AccessPermissionMode;
    label: string;
    desc: string;
}> = [
    {
        id: "ask_always",
        label: "Ask Always",
        desc: "Prompt before write-file or shell commands each message.",
    },
    {
        id: "full_access",
        label: "Full Access",
        desc: "Allow write-file and shell commands without prompting.",
    },
];

function createDefaultSquad(): SquadConfig {
    return normalizeSquadConfig({
        name: "",
        goal: "",
        context: "",
        members: [],
        accessMode: "ask_always",
    });
}

export function SquadEditor({
    initialData,
    availableAgents,
    onCreateSquadAgents,
    onUpsertSquadAgent,
    onDeleteSquadAgent,
    onSave,
    onCancel,
}: SquadEditorProps) {
    const [activeTab, setActiveTab] = useState<"overview" | "team" | "interaction">("overview");
    const [formData, setFormData] = useState<SquadConfig>(() => (
        initialData ? normalizeSquadConfig(initialData) : createDefaultSquad()
    ));
    const [createPrompt, setCreatePrompt] = useState("");
    const [createInfo, setCreateInfo] = useState<string | null>(null);
    const [createError, setCreateError] = useState<string | null>(null);
    const [isCreatingAgents, setIsCreatingAgents] = useState(false);
    const [editingSquadAgent, setEditingSquadAgent] = useState<AgentConfig | undefined>(undefined);

    const interaction = getSquadInteractionConfig(formData);
    const goalValue = getSquadGoal(formData);

    const toggleMember = (agentId: string) => {
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
        goalValue.trim().length > 0 &&
        formData.members.length > 0;
    const userTurnPolicyDescription = interaction.userTurnPolicy === "every_round"
        ? "The squad pauses after each worker turn so the user can steer every step."
        : "The squad continues autonomously and only asks for user input when it is needed.";

    const handleCreateAgents = async () => {
        const prompt = createPrompt.trim();
        if (!prompt || isCreatingAgents) return;

        setIsCreatingAgents(true);
        setCreateError(null);
        setCreateInfo(null);

        try {
            const result = await onCreateSquadAgents(prompt);
            setCreateInfo(result.message);

            const createdIds = result.createdAgents
                .map((agent) => agent.id)
                .filter((id): id is string => Boolean(id));
            if (createdIds.length > 0) {
                setFormData((prev) => ({
                    ...prev,
                    members: Array.from(new Set([...(prev.members || []), ...createdIds])),
                }));
            }
            setCreatePrompt("");
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "Failed to create squad cats.";
            setCreateError(message);
        } finally {
            setIsCreatingAgents(false);
        }
    };

    const handleDeleteAgent = (agent: AgentConfig) => {
        const agentId = agent.id || "";
        if (!agentId) return;

        const confirmed = window.confirm(`Remove "${agent.name}" from squad agents?`);
        if (!confirmed) return;

        onDeleteSquadAgent(agentId);
        setFormData((prev) => ({
            ...prev,
            members: (prev.members || []).filter((memberId) => memberId !== agentId),
        }));
    };

    return (
        <div className="relative bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden flex flex-col w-full max-w-3xl mx-auto h-[85vh] max-h-[85vh]">
            <div className="bg-slate-800/80 p-4 flex justify-between items-center border-b border-slate-700">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <LayoutGrid className="text-purple-500" />
                    {initialData ? "Reorganize Squad" : "Create Squad"}
                </h2>
                <button onClick={onCancel} className="text-slate-400 hover:text-white transition-colors">
                    <X />
                </button>
            </div>

            <div className="px-4 pt-3 border-b border-slate-800">
                <div className="grid grid-cols-3 gap-2">
                    <button
                        type="button"
                        onClick={() => setActiveTab("overview")}
                        className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                            activeTab === "overview"
                                ? "bg-purple-500/20 text-purple-100 border border-purple-500/40"
                                : "bg-slate-900 text-slate-400 border border-slate-800 hover:text-slate-200"
                        }`}
                    >
                        Overview
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab("team")}
                        className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                            activeTab === "team"
                                ? "bg-blue-500/20 text-blue-100 border border-blue-500/40"
                                : "bg-slate-900 text-slate-400 border border-slate-800 hover:text-slate-200"
                        }`}
                    >
                        Team
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab("interaction")}
                        className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                            activeTab === "interaction"
                                ? "bg-emerald-500/20 text-emerald-100 border border-emerald-500/40"
                                : "bg-slate-900 text-slate-400 border border-slate-800 hover:text-slate-200"
                        }`}
                    >
                        Interaction
                    </button>
                </div>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto flex-1 custom-scrollbar">
                {activeTab === "overview" && (
                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <label className="text-sm font-semibold text-slate-300">Squad Name</label>
                            <input
                                type="text"
                                value={formData.name}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all placeholder:text-slate-600"
                                placeholder="e.g. Campaign Party"
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-sm font-semibold text-slate-300">Goal</label>
                            <textarea
                                value={goalValue}
                                onChange={(e) => setFormData({ ...formData, goal: e.target.value, mission: e.target.value })}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all h-24 resize-none placeholder:text-slate-600"
                                placeholder="Define the squad objective (e.g., run a fantasy campaign session with responsive turn-taking)."
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-sm font-semibold text-slate-300">Context (Optional)</label>
                            <textarea
                                value={formData.context || ""}
                                onChange={(e) => setFormData({ ...formData, context: e.target.value })}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all h-24 resize-none placeholder:text-slate-600"
                                placeholder="Shared background for OR (setting, constraints, style, files to maintain, etc)."
                            />
                        </div>

                        <div className="space-y-1.5">
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
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all"
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-sm font-semibold text-slate-300">Access Permissions</label>
                            <p className="text-xs text-slate-500">
                                Controls whether squad workers can run write-file and shell tools without per-message approval.
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {ACCESS_PERMISSION_OPTIONS.map((option) => {
                                    const isSelected = (formData.accessMode || "ask_always") === option.id;
                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            onClick={() => setFormData((prev) => ({ ...prev, accessMode: option.id }))}
                                            className={`text-left rounded-lg border px-3 py-2.5 transition-all ${
                                                isSelected
                                                    ? "border-purple-500/60 bg-purple-500/10 ring-1 ring-purple-500/40"
                                                    : "border-slate-800 bg-slate-950 hover:border-slate-700"
                                            }`}
                                        >
                                            <div className={`text-sm font-semibold ${isSelected ? "text-purple-100" : "text-slate-200"}`}>
                                                {option.label}
                                            </div>
                                            <div className="text-[11px] text-slate-500 mt-1">
                                                {option.desc}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === "team" && (
                    <div className="space-y-3">
                        <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2.5">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <div className="text-sm font-semibold text-slate-200 inline-flex items-center gap-2">
                                        <Sparkles size={14} className="text-blue-300" />
                                        Create Squad Cats
                                    </div>
                                    <div className="text-xs text-slate-500 mt-0.5">
                                        Same natural-language flow as <code>/create_squad</code> (and <code>/create_cats</code>), but scoped to squad-only agents.
                                    </div>
                                </div>
                            </div>
                            <textarea
                                value={createPrompt}
                                onChange={(e) => setCreatePrompt(e.target.value)}
                                className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all h-20 resize-none placeholder:text-slate-600"
                                placeholder="Describe what cats this squad needs (roles, responsibilities, style)."
                            />
                            <div className="flex items-center justify-between gap-3">
                                <div className="text-[11px] text-slate-500">
                                    New squad cats are auto-selected as team members.
                                </div>
                                <button
                                    type="button"
                                    onClick={handleCreateAgents}
                                    disabled={isCreatingAgents || createPrompt.trim().length === 0}
                                    className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    {isCreatingAgents && <Loader2 size={12} className="animate-spin" />}
                                    {isCreatingAgents ? "Creating..." : "Create Squad Cats"}
                                </button>
                            </div>
                            {createInfo && (
                                <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-2.5 py-2">
                                    {createInfo}
                                </div>
                            )}
                            {createError && (
                                <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md px-2.5 py-2">
                                    {createError}
                                </div>
                            )}
                        </div>

                        <label className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                            <Users size={16} className="text-blue-400" />
                            Team Members ({formData.members.length} selected)
                        </label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[44vh] overflow-y-auto pr-1 custom-scrollbar">
                            {availableAgents.length === 0 && (
                                <div className="sm:col-span-2 rounded-lg border border-dashed border-slate-700 bg-slate-950 px-3 py-4 text-center text-xs text-slate-500">
                                    No squad-only cats yet. Create them above to build this team.
                                </div>
                            )}
                            {availableAgents.map((agent) => {
                                const id = agent.id || "";
                                const isSelected = formData.members.includes(id);

                                return (
                                    <div
                                        key={id}
                                        onClick={() => toggleMember(id)}
                                        className={`p-2.5 rounded-lg border cursor-pointer flex items-center gap-2.5 transition-all ${
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
                                        <div className="min-w-0">
                                            <div className={`text-sm font-medium truncate ${isSelected ? "text-purple-100" : "text-slate-300"}`}>{agent.name}</div>
                                            <div className="text-[10px] text-slate-500 truncate">{agent.role}</div>
                                        </div>
                                        <div className="ml-auto flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setEditingSquadAgent(agent);
                                                }}
                                                className="p-1 rounded text-slate-500 hover:text-blue-200 hover:bg-blue-500/10 transition-colors"
                                                title="Edit Squad Cat"
                                            >
                                                <Pencil size={12} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDeleteAgent(agent);
                                                }}
                                                className="p-1 rounded text-slate-500 hover:text-rose-200 hover:bg-rose-500/10 transition-colors"
                                                title="Remove Squad Cat"
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {activeTab === "interaction" && (
                    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                        <div>
                            <div className="text-sm font-semibold text-slate-200">Interaction Mode</div>
                            <div className="text-xs text-slate-500 mt-1">
                                Choose how this squad should present work.
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => selectInteractionMode("master_log")}
                                className={`text-left rounded-lg border p-2.5 transition-all ${
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
                                className={`text-left rounded-lg border p-2.5 transition-all ${
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
                                    Show each character in chat with user-driven turn taking.
                                </div>
                            </button>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <label className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 flex items-start gap-3 cursor-pointer">
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

                            <label className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 flex items-start gap-3 cursor-pointer">
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

                            <label className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 flex items-start gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={interaction.includeDirectorMessagesInChat}
                                    onChange={(e) => updateInteraction({ includeDirectorMessagesInChat: e.target.checked })}
                                    className="mt-0.5 accent-purple-500"
                                />
                                <span>
                                    <span className="text-xs font-semibold text-slate-200">Show orchestrator narration</span>
                                    <span className="block text-[11px] text-slate-500">Include OR decisions as in-chat narration messages.</span>
                                </span>
                            </label>

                            <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
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
                                    {userTurnPolicyDescription}
                                </div>
                            </div>

                        </div>
                    </div>
                )}
            </div>

            <div className="p-4 bg-slate-800/50 border-t border-slate-700 flex flex-col sm:flex-row justify-between sm:items-center gap-3">
                <div className="text-[11px] text-slate-500">
                    Required: Name, Goal, at least 1 Team Member.
                </div>
                <div className="flex items-center justify-end gap-3 w-full sm:w-auto">
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => onSave(normalizeSquadConfig(formData))}
                        disabled={!canSave}
                        className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold shadow-lg shadow-purple-500/20 transition-all active:scale-95"
                    >
                        <Save size={16} /> Save Squad
                    </button>
                </div>
            </div>

            {editingSquadAgent && (
                <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-20 flex items-center justify-center p-4">
                    <div className="w-full max-w-2xl bg-[#1f1f1f] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
                        <AgentEditor
                            initialData={editingSquadAgent}
                            onSave={(agent) => {
                                onUpsertSquadAgent(agent);
                                setEditingSquadAgent(undefined);
                            }}
                            onCancel={() => setEditingSquadAgent(undefined)}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
