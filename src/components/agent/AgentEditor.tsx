"use client";

import { AgentConfig, AgentStyle } from "@/lib/core/Agent";
import { useState } from "react";
import { Save, X, ChevronDown, Volume2, Cpu, Wrench, Sparkles, User, MessageCircle, Code, Shield } from "lucide-react";
import { GROQ_TTS_VOICES, EDGE_TTS_VOICES, BROWSER_TTS_VOICES, loadAudioSettings, saveAudioSettings, TTSProvider } from "@/lib/audio/types";

interface AgentEditorProps {
    initialData?: AgentConfig;
    onSave: (agent: AgentConfig) => void;
    onCancel: () => void;
}

const AGENT_STYLES: { value: AgentStyle; label: string; desc: string; icon: React.ReactNode }[] = [
    { value: "assistant", label: "Assistant", desc: "Helpful and direct", icon: <MessageCircle size={14} /> },
    { value: "character", label: "Character", desc: "Roleplay personality", icon: <User size={14} /> },
    { value: "expert", label: "Expert", desc: "Domain specialist", icon: <Shield size={14} /> },
    { value: "custom", label: "Custom", desc: "Fully freeform", icon: <Sparkles size={14} /> },
];

const GROQ_MODELS = [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", desc: "Best quality" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", desc: "Fast & light" },
    { id: "llama-guard-3-8b", label: "Llama Guard 3", desc: "Safety-focused" },
    { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B", desc: "32K context" },
    { id: "gemma2-9b-it", label: "Gemma 2 9B", desc: "Google model" },
];

// Pick voice list based on the provided TTS provider
function getVoiceOptions(provider: string) {
    if (provider === "browser") {
        return BROWSER_TTS_VOICES.map((v) => ({ id: v.id, label: v.label, desc: `${v.gender} (Browser)` }));
    }
    if (provider === "edge") {
        return EDGE_TTS_VOICES.map((v) => ({ id: v.id, label: v.label, desc: `${v.gender} (Cloud)` }));
    }
    // Default: Groq Orpheus
    return GROQ_TTS_VOICES.map((v) => ({ id: v.id, label: v.label, desc: `${v.gender} (Groq)` }));
}

const TTS_PROVIDERS = [
    { id: "groq", label: "Groq Orpheus", desc: "High quality, needs API key" },
    { id: "edge", label: "Edge (Cloud)", desc: "Natural voices, free" },
    { id: "browser", label: "Browser Native", desc: "Simple, local fallback" },
] as const;

const AVAILABLE_TOOLS = [
    { id: "web_search", name: "Web Search", desc: "Search the internet", icon: "🔍" },
    { id: "fs_read", name: "Read Files", desc: "Read local files", icon: "📄" },
    { id: "fs_write", name: "Write Files", desc: "Create & edit files", icon: "✏️" },
    { id: "shell_execute", name: "Terminal", desc: "Run shell commands", icon: "⌨️" },
];

export function AgentEditor({ initialData, onSave, onCancel }: AgentEditorProps) {
    const [formData, setFormData] = useState<AgentConfig>(
        initialData || {
            name: "",
            role: "Assistant",
            description: "",
            style: "assistant",
            systemPrompt: "",
            tools: [],
            voiceId: "troy",
            model: "llama-3.3-70b-versatile",
        }
    );

    const [activeSection, setActiveSection] = useState<"identity" | "prompt" | "model" | "tools">("identity");
    const [ttsProvider, setTtsProvider] = useState<TTSProvider>(() => loadAudioSettings().ttsProvider || "groq");

    const handleProviderChange = (provider: TTSProvider) => {
        setTtsProvider(provider);
        // Auto-select first voice for the new provider
        const voices = getVoiceOptions(provider);
        setFormData((prev) => ({ ...prev, voiceId: voices[0]?.id || "troy" }));
        // Persist to audio settings
        const settings = loadAudioSettings();
        saveAudioSettings({ ...settings, ttsProvider: provider, ttsVoice: voices[0]?.id || "troy" });
    };

    const toggleTool = (id: string) => {
        setFormData((prev) => {
            const tools = prev.tools || [];
            if (tools.includes(id)) {
                return { ...prev, tools: tools.filter((t) => t !== id) };
            } else {
                return { ...prev, tools: [...tools, id] };
            }
        });
    };

    const sectionButton = (id: typeof activeSection, label: string, icon: React.ReactNode) => (
        <button
            onClick={() => setActiveSection(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all ${activeSection === id
                ? "bg-[#10a37f]/15 text-[#10a37f] ring-1 ring-[#10a37f]/30"
                : "text-[#8e8ea0] hover:text-[#ececec] hover:bg-[#2f2f2f]"
                }`}
        >
            {icon}
            {label}
        </button>
    );

    return (
        <div className="bg-[#1f1f1f] text-[#ececec] h-full flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="px-6 py-4 border-b border-[#424242] flex justify-between items-center bg-[#1f1f1f]">
                <div>
                    <h2 className="text-lg font-medium flex items-center gap-2 text-[#ececec]">
                        {initialData ? "Edit Cat" : "Create New Cat"}
                    </h2>
                    <p className="text-xs text-[#b4b4b4]">Configure your agent&apos;s identity, instructions, and capabilities.</p>
                </div>
                <button onClick={onCancel} className="text-[#b4b4b4] hover:text-[#ececec] transition-colors p-1.5 hover:bg-[#2f2f2f] rounded-lg">
                    <X size={20} />
                </button>
            </div>

            {/* Section Tabs */}
            <div className="px-6 pt-4 pb-2 flex gap-2 border-b border-[#2f2f2f]">
                {sectionButton("identity", "Identity", <User size={13} />)}
                {sectionButton("prompt", "Instructions", <MessageCircle size={13} />)}
                {sectionButton("model", "Model & Voice", <Cpu size={13} />)}
                {sectionButton("tools", "Capabilities", <Wrench size={13} />)}
            </div>

            {/* Content */}
            <div className="p-6 space-y-5 overflow-y-auto flex-1 custom-scrollbar">

                {/* ===== IDENTITY SECTION ===== */}
                {activeSection === "identity" && (
                    <>
                        {/* Name & Role */}
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                                <label className="text-xs font-medium text-[#b4b4b4]">Name</label>
                                <input
                                    type="text"
                                    value={formData.name}
                                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full bg-[#2f2f2f] border border-[#424242] rounded-lg px-3 py-2.5 text-sm text-[#ececec] focus:outline-none focus:border-[#10a37f] transition-all placeholder:text-[#676767]"
                                    placeholder="Name your cat agent"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-xs font-medium text-[#b4b4b4]">Role</label>
                                <input
                                    type="text"
                                    value={formData.role}
                                    onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                                    className="w-full bg-[#2f2f2f] border border-[#424242] rounded-lg px-3 py-2.5 text-sm text-[#ececec] focus:outline-none focus:border-[#10a37f] transition-all placeholder:text-[#676767]"
                                    placeholder="e.g. Senior Developer, Writing Coach"
                                />
                            </div>
                        </div>

                        {/* Description */}
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-[#b4b4b4]">Description</label>
                            <input
                                type="text"
                                maxLength={120}
                                value={formData.description || ""}
                                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                className="w-full bg-[#2f2f2f] border border-[#424242] rounded-lg px-3 py-2.5 text-sm text-[#ececec] focus:outline-none focus:border-[#10a37f] transition-all placeholder:text-[#676767]"
                                placeholder="A brief summary of what this agent does (max 120 chars)"
                            />
                            <div className="text-right text-[10px] text-[#565656]">
                                {(formData.description || "").length}/120
                            </div>
                        </div>

                        {/* Agent Style */}
                        <div className="space-y-2">
                            <label className="text-xs font-medium text-[#b4b4b4]">Personality Style</label>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                {AGENT_STYLES.map((style) => {
                                    const isSelected = (formData.style || "assistant") === style.value;
                                    return (
                                        <button
                                            key={style.value}
                                            onClick={() => setFormData({ ...formData, style: style.value })}
                                            className={`px-3 py-3 rounded-lg border text-left transition-all ${isSelected
                                                ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                }`}
                                        >
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className={isSelected ? "text-[#10a37f]" : "text-[#8e8ea0]"}>
                                                    {style.icon}
                                                </span>
                                                <span className={`text-sm font-medium ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                                                    {style.label}
                                                </span>
                                            </div>
                                            <span className="text-[10px] text-[#8e8ea0]">{style.desc}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </>
                )}

                {/* ===== INSTRUCTIONS SECTION ===== */}
                {activeSection === "prompt" && (
                    <div className="space-y-1.5 h-full flex flex-col">
                        <label className="text-xs font-medium text-[#b4b4b4]">
                            System Prompt
                        </label>
                        <p className="text-[11px] text-[#676767] mb-1">
                            Define how this agent behaves, what it knows, and what it should avoid. The more detail you provide, the better it performs.
                        </p>
                        <textarea
                            value={formData.systemPrompt}
                            onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
                            className="w-full flex-1 min-h-[280px] bg-[#2f2f2f] border border-[#424242] rounded-lg p-4 text-sm text-[#ececec] focus:outline-none focus:border-[#10a37f] transition-all resize-none leading-relaxed placeholder:text-[#676767] font-mono"
                            placeholder={"You are a helpful assistant that...\n\nYou should:\n- Be concise and accurate\n- Ask clarifying questions when needed\n- Provide examples when helpful\n\nYou should NOT:\n- Make up information\n- Be rude or dismissive"}
                        />
                        <div className="text-right text-[10px] text-[#565656]">
                            {formData.systemPrompt.length} characters
                        </div>
                    </div>
                )}

                {/* ===== MODEL & VOICE SECTION ===== */}
                {activeSection === "model" && (
                    <>
                        {/* Model Selection */}
                        <div className="space-y-2">
                            <label className="text-xs font-medium text-[#b4b4b4] flex items-center gap-1.5">
                                <Cpu size={12} />
                                AI Model
                            </label>
                            <div className="grid grid-cols-1 gap-2">
                                {GROQ_MODELS.map((model) => {
                                    const isSelected = (formData.model || "llama-3.3-70b-versatile") === model.id;
                                    return (
                                        <button
                                            key={model.id}
                                            onClick={() => setFormData({ ...formData, model: model.id })}
                                            className={`px-4 py-3 rounded-lg border flex items-center justify-between transition-all ${isSelected
                                                ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                }`}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${isSelected ? "border-[#10a37f]" : "border-[#676767]"
                                                    }`}>
                                                    {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-[#10a37f]" />}
                                                </div>
                                                <span className={`text-sm font-medium ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                                                    {model.label}
                                                </span>
                                            </div>
                                            <span className="text-[11px] text-[#8e8ea0]">{model.desc}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Voice Selection */}
                        <div className="space-y-4 mt-6">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-[#b4b4b4] flex items-center gap-1.5">
                                    <Volume2 size={12} />
                                    TTS Provider
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    {TTS_PROVIDERS.map((p) => {
                                        const isSelected = ttsProvider === p.id;
                                        return (
                                            <button
                                                key={p.id}
                                                onClick={() => handleProviderChange(p.id)}
                                                className={`px-3 py-2 rounded-lg border text-left transition-all ${isSelected
                                                    ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                    : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                    }`}
                                            >
                                                <div className={`text-sm font-medium ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                                                    {p.label}
                                                </div>
                                                <div className="text-[10px] text-[#8e8ea0]">{p.desc}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-xs font-medium text-[#b4b4b4] flex items-center gap-1.5">
                                    <Volume2 size={12} />
                                    TTS Voice
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    {getVoiceOptions(ttsProvider).map((voice) => {
                                        const isSelected = (formData.voiceId || "troy") === voice.id;
                                        return (
                                            <button
                                                key={voice.id}
                                                onClick={() => setFormData({ ...formData, voiceId: voice.id })}
                                                className={`px-3 py-2.5 rounded-lg border flex items-center gap-3 transition-all ${isSelected
                                                    ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                    : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                    }`}
                                            >
                                                <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${isSelected ? "border-[#10a37f]" : "border-[#676767]"
                                                    }`}>
                                                    {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-[#10a37f]" />}
                                                </div>
                                                <div className="flex flex-col text-left">
                                                    <span className={`text-sm font-medium ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                                                        {voice.label}
                                                    </span>
                                                    <span className="text-[10px] text-[#8e8ea0]">{voice.desc}</span>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </>
                )}

                {/* ===== CAPABILITIES SECTION ===== */}
                {activeSection === "tools" && (
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-[#b4b4b4]">Tools & Capabilities</label>
                        <p className="text-[11px] text-[#676767] mb-2">
                            Enable tools to give your agent access to external resources and actions.
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {AVAILABLE_TOOLS.map((tool) => {
                                const isSelected = formData.tools?.includes(tool.id);
                                return (
                                    <div
                                        key={tool.id}
                                        onClick={() => toggleTool(tool.id)}
                                        className={`px-4 py-3.5 rounded-lg border cursor-pointer flex items-center gap-3.5 transition-all ${isSelected
                                            ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                            : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                            }`}
                                    >
                                        <span className="text-xl">{tool.icon}</span>
                                        <div className="flex flex-col flex-1">
                                            <span className={`text-sm font-medium ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                                                {tool.name}
                                            </span>
                                            <span className="text-[10px] text-[#b4b4b4]">{tool.desc}</span>
                                        </div>
                                        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${isSelected
                                            ? "bg-[#10a37f] border-[#10a37f]"
                                            : "border-[#676767] bg-transparent"
                                            }`}>
                                            {isSelected && (
                                                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                                    <path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                                </svg>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-[#424242] bg-[#1f1f1f] flex items-center justify-between mt-auto">
                <div className="text-[11px] text-[#565656]">
                    {formData.name ? `${formData.name} • ${formData.style || "assistant"} • ${(formData.tools || []).length} tools` : "Fill in the details above"}
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-[#b4b4b4] hover:text-[#ececec] hover:bg-[#2f2f2f] transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => onSave(formData)}
                        disabled={!formData.name.trim()}
                        className="flex items-center gap-2 px-6 py-2 bg-[#10a37f] hover:bg-[#1a7f64] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium shadow-sm transition-all"
                    >
                        <Save size={14} />
                        {initialData ? "Update Cat" : "Create Cat"}
                    </button>
                </div>
            </div>
        </div>
    );
}
