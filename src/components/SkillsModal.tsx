/**
 * Skills Management Modal - Import and attach skills to agents
 */

"use client";

import { useState, useEffect } from "react";

import { useEventSubscription } from "@/hooks/useEventSubscription";
import { Plus, Search, Trash2, Copy } from "lucide-react";

interface Skill {
  id: string;
  metadata: {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    tools?: string[];
  };
  createdAt: number;
  tags?: string[];
}

interface SkillsModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentId?: string;
}

export function SkillsModal({ isOpen, onClose, agentId }: SkillsModalProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [markdownInput, setMarkdownInput] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [activeTab, setActiveTab] = useState<"browse" | "import">("browse");

  useEventSubscription({
    channel: "skill", // Subscribe to skill channel events
    onEvent: (event) => {
      if (event.type === "skill.imported" || event.type === "skill.updated") {
        fetchSkills();
      }
    },
  });

  useEffect(() => {
    if (isOpen) {
      fetchSkills();
    }
  }, [isOpen]);

  const fetchSkills = async () => {
    try {
      const res = await fetch("/api/skills");
      const data = await res.json();
      setSkills(data.skills || []);
    } catch (error) {
      console.error("Failed to fetch skills:", error);
    }
  };

  const handleImportSkill = async () => {
    if (!markdownInput.trim()) return;

    setIsImporting(true);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: markdownInput,
          importedBy: agentId,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setMarkdownInput("");
        setActiveTab("browse");
        fetchSkills();
      }
    } catch (error) {
      console.error("Failed to import skill:", error);
    } finally {
      setIsImporting(false);
    }
  };

  const handleDeleteSkill = async (skillId: string) => {
    if (!confirm("Delete this skill?")) return;

    try {
      await fetch(`/api/skills/${skillId}`, { method: "DELETE" });
      fetchSkills();
    } catch (error) {
      console.error("Failed to delete skill:", error);
    }
  };

  const filteredSkills = skills.filter(
    (skill) =>
      skill.metadata.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.metadata.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.tags?.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase())),
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[#1f1f1f] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/10 bg-[#171717]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">Skills Library</h2>
            <button
              onClick={onClose}
              className="text-[#8e8ea0] hover:text-white text-2xl"
            >
              ×
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab("browse")}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === "browse"
                ? "bg-[#10a37f] text-white"
                : "bg-[#2f2f2f] text-[#b4b4b4] hover:bg-[#3a3a3a]"
                }`}
            >
              Browse Skills
            </button>
            <button
              onClick={() => setActiveTab("import")}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === "import"
                ? "bg-[#10a37f] text-white"
                : "bg-[#2f2f2f] text-[#b4b4b4] hover:bg-[#3a3a3a]"
                }`}
            >
              Import Skill
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "browse" ? (
            <div className="p-6 space-y-4">
              {/* Search */}
              <div className="flex items-center gap-2 bg-[#2f2f2f] rounded-lg px-3 py-2">
                <Search size={16} className="text-[#8e8ea0]" />
                <input
                  type="text"
                  placeholder="Search skills..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 bg-transparent text-white placeholder-[#565656] focus:outline-none text-sm"
                />
              </div>

              {/* Skills List */}
              <div className="space-y-3">
                {filteredSkills.length === 0 ? (
                  <div className="text-center py-8 text-[#565656]">
                    {skills.length === 0
                      ? "No skills imported yet"
                      : "No matching skills"}
                  </div>
                ) : (
                  filteredSkills.map((skill) => (
                    <div
                      key={skill.id}
                      className="p-4 bg-[#2f2f2f] border border-white/10 rounded-lg hover:bg-[#3a3a3a] transition-colors"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <h3 className="font-semibold text-white">
                            {skill.metadata.name}
                          </h3>
                          <p className="text-xs text-[#8e8ea0]">
                            v{skill.metadata.version}
                            {skill.metadata.author && ` • by ${skill.metadata.author}`}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleDeleteSkill(skill.id)}
                            className="p-1.5 text-red-400 hover:bg-red-500/10 rounded"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>

                      <p className="text-sm text-[#b4b4b4] mb-2">
                        {skill.metadata.description}
                      </p>

                      {/* Tags and Tools */}
                      <div className="flex flex-wrap gap-2">
                        {skill.tags?.map((tag) => (
                          <span
                            key={tag}
                            className="px-2 py-1 text-xs bg-[#10a37f]/20 text-[#10a37f] rounded"
                          >
                            #{tag}
                          </span>
                        ))}
                        {skill.metadata.tools?.map((tool) => (
                          <span
                            key={tool}
                            className="px-2 py-1 text-xs bg-[#7aa2f7]/20 text-[#7aa2f7] rounded"
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Import Tab */
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-white mb-2">
                  Paste SKILL.md content below:
                </label>
                <textarea
                  value={markdownInput}
                  onChange={(e) => setMarkdownInput(e.target.value)}
                  placeholder={`# My Awesome Skill
## Description
A brief description of what this skill does.

## Tools
- tool-name-1
- tool-name-2

## Examples
...`}
                  className="w-full h-64 bg-[#2f2f2f] border border-white/10 rounded-lg px-4 py-3 text-white placeholder-[#565656] focus:outline-none focus:border-[#10a37f] font-mono text-xs"
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleImportSkill}
                  disabled={!markdownInput.trim() || isImporting}
                  className="flex-1 bg-[#10a37f] hover:bg-[#1a7f64] disabled:bg-[#565656] text-white font-medium py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <Plus size={16} />
                  {isImporting ? "Importing..." : "Import Skill"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
