import React, { useState, useMemo } from "react";
import { ExportScanResult } from "@/lib/import/chatgpt-types";
import { Filter, Search, Users, Eye, EyeOff, Loader2, CheckCircle2 } from "lucide-react";

interface ImportFilterStepProps {
    scanResult: ExportScanResult;
    onConfirm: (selectedIds: string[]) => void;
    onCancel: () => void;
}

type FilterType = "all" | "default" | "gpt" | "project";

export function ImportFilterStep({ scanResult, onCancel }: ImportFilterStepProps) {
    const [dateStart, setDateStart] = useState<string>("");
    const [dateEnd, setDateEnd] = useState<string>("");
    const [searchQuery, setSearchQuery] = useState("");
    const [typeFilter, setTypeFilter] = useState<FilterType>("all");

    // Local state to track imports, initialized from scan result
    const [importedIds, setImportedIds] = useState<Set<string>>(() => {
        const set = new Set<string>();
        scanResult.conversations.forEach(c => {
            if (c.isImported) set.add(c.id);
        });
        return set;
    });

    const [togglingId, setTogglingId] = useState<string | null>(null);

    // Filter Logic
    const filteredConversations = useMemo(() => {
        return scanResult.conversations.filter((conv) => {
            // 1. Date Range
            if (dateStart) {
                const start = new Date(dateStart).getTime();
                if (conv.create_time < start) return false;
            }
            if (dateEnd) {
                const end = new Date(dateEnd).getTime();
                // Add one day to include the end date fully
                if (conv.create_time > end + 86400000) return false;
            }

            // 2. Type Filter
            if (typeFilter !== "all" && conv.category !== typeFilter) return false;

            // 3. Search
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                return (
                    conv.title.toLowerCase().includes(q) ||
                    (conv.category === "gpt" && scanResult.gpts[conv.gizmo_id || ""]?.name?.toLowerCase().includes(q)) ||
                    (conv.category === "project" && scanResult.projects[conv.conversation_template_id || ""]?.name?.toLowerCase().includes(q))
                );
            }

            return true;
        });
    }, [scanResult, dateStart, dateEnd, typeFilter, searchQuery]);

    const handleToggle = async (id: string, currentStatus: boolean) => {
        if (togglingId) return; // Prevent concurrent toggles for now
        setTogglingId(id);

        const newStatus = !currentStatus;

        try {
            const res = await fetch("/api/import/toggle", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, show: newStatus }),
            });

            if (!res.ok) throw new Error("Failed to toggle visibility");

            // Update local state
            const next = new Set(importedIds);
            if (newStatus) {
                next.add(id);
            } else {
                next.delete(id);
            }
            setImportedIds(next);

        } catch (err) {
            console.error(err);
            // Optionally show error toast
        } finally {
            setTogglingId(null);
        }
    };

    const importedCount = importedIds.size;
    const totalCount = scanResult.conversations.length;

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] text-[#ececec]">
            {/* Header / Controls */}
            <div className="p-4 border-b border-white/10 space-y-4">
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                        <Filter size={18} className="text-[#10a37f]" />
                        Library Filter
                    </h3>
                    <div className="text-xs text-[#8e8ea0]">
                        Showing <span className="text-[#10a37f] font-bold">{importedCount}</span> / {totalCount} conversations
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* Date Range */}
                    <div className="flex flex-col gap-1">
                        <label className="text-xs text-[#8e8ea0] uppercase font-semibold">Date Range</label>
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                value={dateStart}
                                onChange={(e) => setDateStart(e.target.value)}
                                className="bg-[#2f2f2f] border border-white/10 rounded px-2 py-1 text-xs w-full focus:outline-none focus:border-[#10a37f]"
                            />
                            <span className="text-[#8e8ea0]">-</span>
                            <input
                                type="date"
                                value={dateEnd}
                                onChange={(e) => setDateEnd(e.target.value)}
                                className="bg-[#2f2f2f] border border-white/10 rounded px-2 py-1 text-xs w-full focus:outline-none focus:border-[#10a37f]"
                            />
                        </div>
                    </div>

                    {/* Type Filter */}
                    <div className="flex flex-col gap-1">
                        <label className="text-xs text-[#8e8ea0] uppercase font-semibold">Content Type</label>
                        <select
                            value={typeFilter}
                            onChange={(e) => setTypeFilter(e.target.value as FilterType)}
                            className="bg-[#2f2f2f] border border-white/10 rounded px-2 py-1 text-xs w-full focus:outline-none focus:border-[#10a37f]"
                        >
                            <option value="all">All Content</option>
                            <option value="default">Standard Chats</option>
                            <option value="gpt">GPTs</option>
                            <option value="project">Projects (Squads)</option>
                        </select>
                    </div>

                    {/* Search */}
                    <div className="flex flex-col gap-1">
                        <label className="text-xs text-[#8e8ea0] uppercase font-semibold">Search</label>
                        <div className="relative">
                            <Search size={14} className="absolute left-2 top-1.5 text-[#8e8ea0]" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search titles..."
                                className="bg-[#2f2f2f] border border-white/10 rounded pl-8 pr-2 py-1 text-xs w-full focus:outline-none focus:border-[#10a37f]"
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* List Area */}
            <div className="flex-1 overflow-hidden flex flex-col">
                {/* List Header */}
                <div className="flex items-center gap-3 px-4 py-2 bg-[#2f2f2f]/50 border-b border-white/5 text-xs font-semibold text-[#8e8ea0]">
                    <div className="w-16 text-center">Visible</div>
                    <div className="flex-1">Conversation Title</div>
                    <div className="w-24">Date</div>
                    <div className="w-20 text-center">Msgs</div>
                    <div className="w-24 text-right">Type</div>
                </div>

                {/* Scrollable List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                    {filteredConversations.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-[#8e8ea0] opacity-50">
                            <Search size={32} className="mb-2" />
                            <p className="text-sm">No conversations match your filters.</p>
                        </div>
                    ) : (
                        filteredConversations.map((conv) => {
                            const isImported = importedIds.has(conv.id);
                            const isToggling = togglingId === conv.id;

                            return (
                                <div
                                    key={conv.id}
                                    className={`flex items-center gap-3 px-3 py-2 rounded transition-colors hover:bg-[#2f2f2f] border border-transparent ${isImported ? "bg-[#2f2f2f]/30" : "opacity-70 hover:opacity-100"}`}
                                >
                                    <div className="w-16 flex justify-center">
                                        <button
                                            onClick={() => handleToggle(conv.id, isImported)}
                                            disabled={isToggling}
                                            className={`p-1.5 rounded transition-colors ${isImported
                                                    ? "text-[#10a37f] bg-[#10a37f]/10 hover:bg-[#10a37f]/20"
                                                    : "text-[#8e8ea0] hover:text-white hover:bg-white/10"
                                                }`}
                                            title={isImported ? "Hide Conversation" : "Show Conversation"}
                                        >
                                            {isToggling ? (
                                                <Loader2 size={16} className="animate-spin" />
                                            ) : isImported ? (
                                                <Eye size={16} />
                                            ) : (
                                                <EyeOff size={16} />
                                            )}
                                        </button>
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <div className={`text-sm truncate ${isImported ? "text-[#ececec]" : "text-[#b4b4b4]"}`}>
                                            {conv.title}
                                        </div>
                                        {/* Subtext for GPT/Project name */}
                                        {(conv.category === "gpt" || conv.category === "project") && (
                                            <div className="text-[10px] text-[#8e8ea0] flex items-center gap-1">
                                                <Users size={10} />
                                                {conv.category === "gpt" ? "GPT" : "Project"}
                                            </div>
                                        )}
                                    </div>

                                    <div className="w-24 text-xs text-[#8e8ea0]">
                                        {new Date(conv.create_time).toLocaleDateString()}
                                    </div>

                                    <div className="w-20 text-xs text-center text-[#8e8ea0]">
                                        {conv.message_count}
                                    </div>

                                    <div className="w-24 text-right">
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-bold tracking-wider ${conv.category === "project" ? "bg-purple-500/20 text-purple-300" :
                                            conv.category === "gpt" ? "bg-blue-500/20 text-blue-300" :
                                                "bg-gray-700/50 text-gray-400"
                                            }`}>
                                            {conv.category}
                                        </span>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* Footer Actions */}
            <div className="p-4 border-t border-white/10 flex items-center justify-end bg-[#1e1e1e]">
                <button
                    onClick={onCancel}
                    className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded text-sm font-medium transition-colors"
                >
                    Close
                </button>
            </div>
        </div>
    );
}
