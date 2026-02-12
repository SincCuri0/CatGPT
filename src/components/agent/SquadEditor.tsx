"use client";

import { useState } from "react";
import { SquadConfig } from "@/lib/core/Squad";
import { AgentConfig } from "@/lib/core/Agent";
import { Save, Users, X, LayoutGrid } from "lucide-react";

interface SquadEditorProps {
    initialData?: SquadConfig;
    availableAgents: AgentConfig[];
    onSave: (squad: SquadConfig) => void;
    onCancel: () => void;
}

export function SquadEditor({
    initialData,
    availableAgents,
    onSave,
    onCancel,
}: SquadEditorProps) {
    const [formData, setFormData] = useState<SquadConfig>(
        initialData || {
            name: "",
            mission: "",
            directorId: "",
            members: [],
        }
    );

    const toggleMember = (agentId: string) => {
        setFormData((prev) => {
            const current = prev.members || [];
            if (current.includes(agentId)) {
                return { ...prev, members: current.filter((id) => id !== agentId) };
            } else {
                return { ...prev, members: [...current, agentId] };
            }
        });
    };

    return (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden flex flex-col h-full max-w-2xl mx-auto mt-10">
            <div className="bg-slate-800/80 p-6 flex justify-between items-center border-b border-slate-700">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <LayoutGrid className="text-purple-500" />
                    {initialData ? "Reorganize Department" : "New Department"}
                </h2>
                <button onClick={onCancel} className="text-slate-400 hover:text-white transition-colors">
                    <X />
                </button>
            </div>

            <div className="p-8 space-y-6 overflow-y-auto flex-1">
                <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-300">Department Name</label>
                    <input
                        type="text"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all placeholder:text-slate-600"
                        placeholder="e.g. Innovation Labs"
                    />
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-300">Mission Statement</label>
                    <textarea
                        value={formData.mission}
                        onChange={(e) => setFormData({ ...formData, mission: e.target.value })}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all h-24 resize-none placeholder:text-slate-600"
                        placeholder="Define the strategic objectives for this unit..."
                    />
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-300">Department Head (Director)</label>
                    <select
                        value={formData.directorId}
                        onChange={(e) => setFormData({ ...formData, directorId: e.target.value })}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 appearance-none"
                    >
                        <option value="" disabled>Select a Director...</option>
                        {availableAgents.map(agent => (
                            <option key={agent.id} value={agent.id}>{agent.name} - {agent.role}</option>
                        ))}
                    </select>
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                        <Users size={16} className="text-blue-400" />
                        Team Members
                    </label>
                    <div className="grid grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-2">
                        {availableAgents.map(agent => {
                            const isSelected = formData.members.includes(agent.id || "");
                            const isDirector = formData.directorId === agent.id;

                            if (isDirector) return null; // Don't show director in member list

                            return (
                                <div
                                    key={agent.id}
                                    onClick={() => toggleMember(agent.id || "")}
                                    className={`p-3 rounded-lg border cursor-pointer flex items-center gap-3 transition-all ${isSelected
                                            ? "bg-purple-500/10 border-purple-500/50"
                                            : "bg-slate-950 border-slate-800 hover:border-slate-700"
                                        }`}
                                >
                                    <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${isSelected ? "bg-purple-500 border-purple-500" : "border-slate-700"
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
            </div>

            <div className="p-6 bg-slate-800/50 border-t border-slate-700 flex justify-end gap-3">
                <button
                    onClick={onCancel}
                    className="px-5 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                >
                    Cancel
                </button>
                <button
                    onClick={() => onSave(formData)}
                    className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-semibold shadow-lg shadow-purple-500/20 transition-all active:scale-95"
                >
                    <Save size={16} /> Save Department
                </button>
            </div>
        </div>
    );
}
