"use client";

import { AgentConfig } from "@/lib/core/Agent";
import { motion } from "framer-motion";
import { Cat, Fish, MousePointer2, Crown } from "lucide-react";

interface AgentCardProps {
    agent: AgentConfig;
    onClick?: () => void;
    isActive?: boolean;
}

export function AgentCard({ agent, onClick, isActive }: AgentCardProps) {
    return (
        <motion.div
            layout
            onClick={onClick}
            className={`relative p-3 rounded-lg cursor-pointer transition-colors group border ${isActive
                    ? "bg-[#2f2f2f] border-[#424242]"
                    : "bg-transparent border-transparent hover:bg-[#212121]"
                }`}
        >
            <div className="flex justify-between items-start mb-1 relative z-10">
                <div className="flex items-center gap-3 w-full">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${agent.role.includes("Director") || agent.role.includes("Top Cat")
                            ? "bg-[#10a37f] text-white"
                            : "bg-[#424242] text-[#ececec]"
                        }`}>
                        {agent.role.includes("Director") ? <Crown size={14} /> : <Cat size={16} />}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className={`font-medium text-sm truncate ${isActive ? "text-white" : "text-[#ececec]"}`}>
                            {agent.name}
                        </h3>
                        <p className="text-xs text-[#b4b4b4] truncate">
                            {agent.role}
                        </p>
                    </div>
                </div>
            </div>

            {/* Tools / Capabilities (only show if active or hovered to keep sidebar clean) */}
            <div className={`mt-2 flex flex-wrap gap-1.5 ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}>
                {agent.tools && agent.tools.length > 0 ? (
                    agent.tools.slice(0, 3).map(t => (
                        <span key={t} className="text-[10px] bg-[#171717] text-[#b4b4b4] px-1.5 py-0.5 rounded border border-[#424242] flex items-center gap-1">
                            <MousePointer2 size={8} /> {t.replace('_', ' ')}
                        </span>
                    ))
                ) : (
                    <span className="text-[10px] text-[#b4b4b4] flex items-center gap-1.5 px-1">
                        <Fish size={10} /> Conversational
                    </span>
                )}
                {agent.tools && agent.tools.length > 3 && (
                    <span className="text-[10px] text-[#565f89] px-1.5 py-0.5">+</span>
                )}
            </div>

            {/* Active Indicator Dot */}
            {isActive && (
                <div className="absolute top-1/2 right-3 -translate-y-1/2 w-1.5 h-1.5 bg-[#10a37f] rounded-full shadow-[0_0_8px_rgba(16,163,127,0.5)]" />
            )}
        </motion.div>
    );
}
