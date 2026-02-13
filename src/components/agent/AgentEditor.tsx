"use client";

import { AgentConfig, AgentStyle } from "@/lib/core/Agent";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Save, X, Volume2, Cpu, Wrench, Sparkles, User, MessageCircle, Shield } from "lucide-react";
import { GROQ_TTS_VOICES, EDGE_TTS_VOICES, BROWSER_TTS_VOICES, loadAudioSettings, saveAudioSettings, TTSProvider } from "@/lib/audio/types";
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORT_OPTIONS } from "@/lib/llm/constants";
import {
    buildFallbackCatalogProviders,
    defaultModelForCatalogProvider,
    defaultModelForProviderWithRequirements,
    filterModelsByCapabilityRequirements,
    isModelChatCapable,
    supportsReasoningEffort,
    supportsToolUse,
} from "@/lib/llm/modelCatalog";
import { useSettings } from "@/hooks/useSettings";
import { debugClientError, debugClientLog } from "@/lib/debug/client";
import { useModelCatalog } from "@/hooks/useModelCatalog";

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

type VoiceOption = { id: string; label: string; desc: string };
const ELEVENLABS_VOICES_CACHE_KEY = "cat_gpt_elevenlabs_voices";

function getVoiceOptions(provider: string, elevenLabsVoices: VoiceOption[]): VoiceOption[] {
    if (provider === "browser") {
        return BROWSER_TTS_VOICES.map((v) => ({ id: v.id, label: v.label, desc: `${v.gender} (Browser)` }));
    }
    if (provider === "edge") {
        return EDGE_TTS_VOICES.map((v) => ({ id: v.id, label: v.label, desc: `${v.gender} (Cloud)` }));
    }
    if (provider === "elevenlabs") {
        return elevenLabsVoices;
    }
    return GROQ_TTS_VOICES.map((v) => ({ id: v.id, label: v.label, desc: `${v.gender} (Groq)` }));
}

const TTS_PROVIDERS = [
    { id: "groq", label: "Groq Orpheus", desc: "High quality, needs API key" },
    { id: "edge", label: "Edge (Cloud)", desc: "Natural voices, free" },
    { id: "elevenlabs", label: "ElevenLabs", desc: "Premium cloned voices" },
    { id: "browser", label: "Browser Native", desc: "Simple, local fallback" },
] as const;

const AVAILABLE_TOOLS = [
    { id: "web_search", name: "Web Search", desc: "Search the internet", icon: "🔍" },
    { id: "fs_read", name: "Read Files", desc: "Read local files", icon: "📄" },
    { id: "fs_write", name: "Write Files", desc: "Create & edit files", icon: "✏️" },
    { id: "shell_execute", name: "Terminal", desc: "Run shell commands", icon: "⌨️" },
];
const FALLBACK_LLM_PROVIDERS = buildFallbackCatalogProviders();

function formatCompactTokenCount(value?: number): string | null {
    if (typeof value !== "number" || value <= 0) return null;
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
    if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
    return String(value);
}

function getModelBadges(model: {
    capabilities?: {
        chat?: boolean;
        reasoning?: boolean;
        nativeTools?: boolean;
        embeddings?: boolean;
    };
    metadata?: {
        contextWindow?: number;
        maxOutputTokens?: number;
    };
}): string[] {
    const badges: string[] = [];
    if (model.capabilities?.chat) badges.push("Chat");
    if (model.capabilities?.nativeTools) badges.push("Tools");
    if (model.capabilities?.reasoning) badges.push("Reasoning");
    if (model.capabilities?.embeddings) badges.push("Embeddings");

    const ctx = formatCompactTokenCount(model.metadata?.contextWindow);
    if (ctx) badges.push(`${ctx} ctx`);

    const out = formatCompactTokenCount(model.metadata?.maxOutputTokens);
    if (out) badges.push(`${out} out`);

    return badges;
}

export function AgentEditor({ initialData, onSave, onCancel }: AgentEditorProps) {
    const { apiKey, apiKeys, debugLogsEnabled } = useSettings();
    const { providers: llmProviders, isRefreshingModels, refreshModels } = useModelCatalog();
    const [formData, setFormData] = useState<AgentConfig>(
        initialData || {
            name: "",
            role: "Assistant",
            description: "",
            style: "assistant",
            systemPrompt: "",
            tools: [],
            voiceId: "troy",
            provider: "groq",
            model: "llama-3.3-70b-versatile",
            reasoningEffort: DEFAULT_REASONING_EFFORT,
        }
    );

    const [activeSection, setActiveSection] = useState<"identity" | "prompt" | "model" | "tools">("identity");
    const [modelSubTab, setModelSubTab] = useState<"llm" | "voice">("llm");
    const [toolFilteringEnabled, setToolFilteringEnabled] = useState<boolean>(() => (initialData?.tools?.length || 0) > 0);
    const [reasoningFilteringEnabled, setReasoningFilteringEnabled] = useState<boolean>(
        () => Boolean(initialData && (initialData.reasoningEffort || DEFAULT_REASONING_EFFORT) !== "none"),
    );
    const [ttsProvider, setTtsProvider] = useState<TTSProvider>(() => loadAudioSettings().ttsProvider || "groq");
    const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
    const [generatePromptError, setGeneratePromptError] = useState<string | null>(null);
    const [elevenLabsVoices, setElevenLabsVoices] = useState<VoiceOption[]>([]);
    const [isRefreshingVoices, setIsRefreshingVoices] = useState(false);

    const loadElevenLabsVoices = useCallback(async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}) => {
        if (!forceRefresh) {
            try {
                const cached = localStorage.getItem(ELEVENLABS_VOICES_CACHE_KEY);
                if (cached) {
                    const parsed = JSON.parse(cached) as VoiceOption[];
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        setElevenLabsVoices(parsed);
                        return;
                    }
                }
            } catch {
                // ignore cache parse errors and fall through to network fetch
            }
        }

        const endpoint = forceRefresh ? "/api/elevenlabs/voices?refresh=1" : "/api/elevenlabs/voices";
        if (forceRefresh) {
            setIsRefreshingVoices(true);
        }

        try {
            debugClientLog("AgentEditor", `Requesting ${endpoint}`);
            const response = await fetch(endpoint, {
                headers: debugLogsEnabled ? { "x-debug-logs": "1" } : undefined,
            });
            if (!response.ok) {
                throw new Error("Voice fetch failed");
            }

            const data = await response.json();
            if (Array.isArray(data.voices)) {
                const mapped = data.voices.map((voice: { id: string; label: string; gender?: string }) => ({
                    id: voice.id,
                    label: voice.label,
                    desc: `${voice.gender || "neutral"} (ElevenLabs)`,
                }));
                setElevenLabsVoices(mapped);
                localStorage.setItem(ELEVENLABS_VOICES_CACHE_KEY, JSON.stringify(mapped));
            }
        } catch (error) {
            debugClientError("AgentEditor", error, "Failed to load ElevenLabs voices");
        } finally {
            if (forceRefresh) {
                setIsRefreshingVoices(false);
            }
        }
    }, [debugLogsEnabled]);

    useEffect(() => {
        void loadElevenLabsVoices();
    }, [loadElevenLabsVoices]);

    const voiceOptions = useMemo(() => getVoiceOptions(ttsProvider, elevenLabsVoices), [ttsProvider, elevenLabsVoices]);

    const handleProviderChange = (provider: TTSProvider) => {

        setTtsProvider(provider);
        // Auto-select first voice for the new provider
        const voices = getVoiceOptions(provider, elevenLabsVoices);
        setFormData((prev) => ({ ...prev, voiceId: voices[0]?.id || prev.voiceId || "troy" }));
        // Persist to audio settings
        const settings = loadAudioSettings();
        saveAudioSettings({ ...settings, ttsProvider: provider, ttsVoice: voices[0]?.id || settings.ttsVoice || "troy" });
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

    // Helpers for LLM selection
    const currentProvider = useMemo(() => (
        llmProviders.find((provider) => provider.id === (formData.provider || "groq"))
        || llmProviders[0]
        || FALLBACK_LLM_PROVIDERS[0]
    ), [formData.provider, llmProviders]);
    const hasSelectedTools = (formData.tools?.length || 0) > 0;
    const effectiveToolFilteringEnabled = toolFilteringEnabled || hasSelectedTools;
    const chatCapableModels = useMemo(
        () => (currentProvider?.models || []).filter((model) => isModelChatCapable(model, currentProvider?.id || "groq")),
        [currentProvider],
    );
    const filteredByCapabilityModels = useMemo(
        () => filterModelsByCapabilityRequirements(currentProvider?.id || "groq", chatCapableModels, {
            requireToolUse: effectiveToolFilteringEnabled,
            requireReasoning: reasoningFilteringEnabled,
        }),
        [chatCapableModels, currentProvider?.id, effectiveToolFilteringEnabled, reasoningFilteringEnabled],
    );
    const capabilityFiltersActive = effectiveToolFilteringEnabled || reasoningFilteringEnabled;
    const availableModels = filteredByCapabilityModels.length > 0
        ? filteredByCapabilityModels
        : chatCapableModels;
    const fellBackFromCapabilityFiltering = capabilityFiltersActive && filteredByCapabilityModels.length === 0;
    const selectedModelId = formData.model || currentProvider?.defaultModel || availableModels[0]?.id || "llama-3.3-70b-versatile";
    const selectedModel = useMemo(
        () => availableModels.find((model) => model.id === selectedModelId),
        [availableModels, selectedModelId],
    );
    const selectedModelSupportsToolUse = selectedModel
        ? (selectedModel.capabilities?.nativeTools ?? supportsToolUse(currentProvider?.id || "groq", selectedModel.id))
        : supportsToolUse(currentProvider?.id || "groq", selectedModelId);
    const selectedModelSupportsReasoning = selectedModel
        ? (selectedModel.capabilities?.reasoning ?? supportsReasoningEffort(currentProvider?.id || "groq", selectedModel.id))
        : supportsReasoningEffort(currentProvider?.id || "groq", selectedModelId);

    useEffect(() => {
        if (!hasSelectedTools) return;
        if (toolFilteringEnabled) return;
        setToolFilteringEnabled(true);
    }, [hasSelectedTools, toolFilteringEnabled]);

    useEffect(() => {
        if (reasoningFilteringEnabled) {
            if ((formData.reasoningEffort || "none") === "none") {
                setFormData((prev) => ({ ...prev, reasoningEffort: DEFAULT_REASONING_EFFORT }));
            }
            return;
        }
        if ((formData.reasoningEffort || "none") !== "none") {
            setFormData((prev) => ({ ...prev, reasoningEffort: "none" }));
        }
    }, [formData.reasoningEffort, reasoningFilteringEnabled]);

    useEffect(() => {
        if (!currentProvider || availableModels.length === 0) return;
        const selectedModelInFilteredList = availableModels.some((model) => model.id === (formData.model || ""));
        if (selectedModelInFilteredList) return;

        const defaultModel = defaultModelForProviderWithRequirements(currentProvider, {
            requireToolUse: effectiveToolFilteringEnabled,
            requireReasoning: reasoningFilteringEnabled,
        });
        const modelFromFilteredList = availableModels.find((model) => model.id === defaultModel)?.id;
        const fallbackModel = modelFromFilteredList || availableModels[0]?.id || currentProvider.defaultModel;
        if (!fallbackModel) return;
        if (fallbackModel === formData.model) return;

        setFormData((prev) => ({ ...prev, model: fallbackModel }));
    }, [
        availableModels,
        currentProvider,
        effectiveToolFilteringEnabled,
        formData.model,
        reasoningFilteringEnabled,
    ]);

    useEffect(() => {
        const currentEffort = formData.reasoningEffort || DEFAULT_REASONING_EFFORT;
        if (!reasoningFilteringEnabled || selectedModelSupportsReasoning || currentEffort === "none") return;
        setFormData((prev) => ({ ...prev, reasoningEffort: "none" }));
    }, [formData.reasoningEffort, reasoningFilteringEnabled, selectedModelSupportsReasoning]);

    useEffect(() => {
        if (!effectiveToolFilteringEnabled || selectedModelSupportsToolUse) return;
        if (!currentProvider) return;
        const fallbackModel = defaultModelForProviderWithRequirements(currentProvider, {
            requireToolUse: true,
            requireReasoning: reasoningFilteringEnabled,
        });
        if (!fallbackModel || fallbackModel === formData.model) return;
        setFormData((prev) => ({ ...prev, model: fallbackModel }));
    }, [
        currentProvider,
        effectiveToolFilteringEnabled,
        formData.model,
        reasoningFilteringEnabled,
        selectedModelSupportsToolUse,
    ]);

    useEffect(() => {
        if (!currentProvider || availableModels.length === 0) return;
        if (!(formData.model || "").trim()) {
            const defaultModel = defaultModelForProviderWithRequirements(currentProvider, {
                requireToolUse: effectiveToolFilteringEnabled,
                requireReasoning: reasoningFilteringEnabled,
            });
            const fallbackModel = availableModels.find((model) => model.id === defaultModel)?.id || availableModels[0]?.id;
            if (!fallbackModel) return;
            setFormData((prev) => ({ ...prev, model: fallbackModel }));
            return;
        }
    }, [
        availableModels,
        currentProvider,
        effectiveToolFilteringEnabled,
        formData.model,
        reasoningFilteringEnabled,
    ]);

    const handleGenerateInstructions = async () => {
        setIsGeneratingPrompt(true);
        setGeneratePromptError(null);

        try {
            debugClientLog("AgentEditor", "Requesting /api/agents/generate-instructions", {
                provider: formData.provider || "groq",
                model: selectedModelId,
                reasoningEffort: formData.reasoningEffort || DEFAULT_REASONING_EFFORT,
            });
            const response = await fetch("/api/agents/generate-instructions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-groq-api-key": apiKey || "",
                    "x-api-keys": JSON.stringify(apiKeys),
                    ...(debugLogsEnabled ? { "x-debug-logs": "1" } : {}),
                },
                body: JSON.stringify({
                    provider: formData.provider || "groq",
                    model: selectedModelId,
                    reasoningEffort: formData.reasoningEffort || DEFAULT_REASONING_EFFORT,
                    name: formData.name || "",
                    role: formData.role || "",
                    style: formData.style || "assistant",
                    description: formData.description || "",
                    existingInstructions: formData.systemPrompt || "",
                }),
            });

            const data = await response.json();
            debugClientLog("AgentEditor", "Received /api/agents/generate-instructions response", {
                ok: response.ok,
                status: response.status,
            });

            if (!response.ok || data.error) {
                throw new Error(data.error || "Failed to generate instructions.");
            }

            const generatedText = typeof data.instructions === "string" ? data.instructions.trim() : "";
            if (!generatedText) {
                throw new Error("Model returned empty instructions.");
            }

            setFormData((prev) => ({ ...prev, systemPrompt: generatedText }));
        } catch (error: unknown) {
            debugClientError("AgentEditor", error, "Failed to generate instructions");
            const message = error instanceof Error ? error.message : "Failed to generate instructions.";
            setGeneratePromptError(message);
        } finally {
            setIsGeneratingPrompt(false);
        }
    };

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
                        <div className="flex items-center justify-between gap-3">
                            <label className="text-xs font-medium text-[#b4b4b4]">
                                System Prompt
                            </label>
                            <button
                                type="button"
                                onClick={handleGenerateInstructions}
                                disabled={isGeneratingPrompt}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[#424242] text-[11px] font-medium text-[#d4d4d8] hover:bg-[#2f2f2f] hover:border-[#676767] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <Sparkles size={12} />
                                {isGeneratingPrompt ? "Generating..." : "Generate Instructions"}
                            </button>
                        </div>
                        <p className="text-[11px] text-[#676767] mb-1">
                            Define how this agent behaves, what it knows, and what it should avoid. The more detail you provide, the better it performs.
                        </p>
                        {generatePromptError && (
                            <p className="text-[11px] text-[#f87171] mb-1">
                                {generatePromptError}
                            </p>
                        )}
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
                    <div className="space-y-4">
                        <div className="inline-flex p-1 rounded-lg border border-[#424242] bg-[#252525]">
                            <button
                                type="button"
                                onClick={() => setModelSubTab("llm")}
                                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${modelSubTab === "llm"
                                    ? "bg-[#10a37f]/20 text-white border border-[#10a37f]/40"
                                    : "text-[#9ca3af] hover:text-white"
                                    }`}
                            >
                                AI Model
                            </button>
                            <button
                                type="button"
                                onClick={() => setModelSubTab("voice")}
                                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${modelSubTab === "voice"
                                    ? "bg-[#10a37f]/20 text-white border border-[#10a37f]/40"
                                    : "text-[#9ca3af] hover:text-white"
                                    }`}
                            >
                                Voice
                            </button>
                        </div>

                        {modelSubTab === "llm" ? (
                            <>
                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-[#b4b4b4] flex items-center gap-1.5">
                                        <Cpu size={12} />
                                        AI Provider
                                    </label>
                                    <div className="grid grid-cols-2 gap-2">
                                        {llmProviders.map((p) => {
                                            const isSelected = (formData.provider || "groq") === p.id;
                                            const providerChatModels = p.models.filter((model) => isModelChatCapable(model, p.id));
                                            const defaultFilteredModel = defaultModelForProviderWithRequirements(p, {
                                                requireToolUse: effectiveToolFilteringEnabled,
                                                requireReasoning: reasoningFilteringEnabled,
                                            });
                                            const defaultChatModel = providerChatModels.find((model) => model.id === defaultFilteredModel)?.id
                                                || providerChatModels[0]?.id
                                                || defaultModelForCatalogProvider(p);
                                            return (
                                                <button
                                                    key={p.id}
                                                    onClick={() => {
                                                        setFormData({
                                                            ...formData,
                                                            provider: p.id,
                                                            model: defaultChatModel,
                                                        });
                                                    }}
                                                    className={`px-2.5 py-2 rounded-lg border text-left transition-all ${isSelected
                                                        ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                        : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                        }`}
                                                >
                                                    <div className={`text-xs font-semibold ${isSelected ? "text-white" : "text-[#ececec]"}`}>{p.name}</div>
                                                    <div className="text-[10px] text-[#8e8ea0] truncate">{p.description}</div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-[#b4b4b4]">Capability Filters</label>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (hasSelectedTools) return;
                                                setToolFilteringEnabled((prev) => !prev);
                                            }}
                                            className={`px-3 py-2.5 rounded-lg border text-left transition-all ${effectiveToolFilteringEnabled
                                                ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                } ${hasSelectedTools ? "opacity-80 cursor-not-allowed" : ""}`}
                                        >
                                            <div className="text-xs font-medium text-[#ececec]">Tool Use</div>
                                            <div className="text-[10px] text-[#8e8ea0] mt-0.5">
                                                {hasSelectedTools
                                                    ? "Enabled automatically because this agent has tools."
                                                    : (effectiveToolFilteringEnabled ? "Filtering to tool-capable models." : "Show all chat-capable models.")}
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setReasoningFilteringEnabled((prev) => !prev)}
                                            className={`px-3 py-2.5 rounded-lg border text-left transition-all ${reasoningFilteringEnabled
                                                ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                }`}
                                        >
                                            <div className="text-xs font-medium text-[#ececec]">Reasoning</div>
                                            <div className="text-[10px] text-[#8e8ea0] mt-0.5">
                                                {reasoningFilteringEnabled
                                                    ? "Filtering to reasoning-capable models."
                                                    : "Reasoning disabled (effort hidden)."}
                                            </div>
                                        </button>
                                    </div>
                                    {fellBackFromCapabilityFiltering && (
                                        <p className="text-[11px] text-[#f59e0b]">
                                            No models matched the active filters for this provider. Showing all chat-capable models.
                                        </p>
                                    )}
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <label className="text-xs font-medium text-[#b4b4b4] flex items-center gap-1.5">
                                            <Cpu size={12} />
                                            AI Model ({currentProvider.name})
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() => void refreshModels()}
                                            disabled={isRefreshingModels}
                                            className="px-2.5 py-1 rounded-md border border-[#424242] text-[11px] font-medium text-[#d4d4d8] hover:bg-[#2f2f2f] hover:border-[#676767] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                        >
                                            {isRefreshingModels ? "Refreshing..." : "Refresh Models"}
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-1 gap-1.5 max-h-[260px] overflow-y-auto pr-1 custom-scrollbar">
                                        {availableModels.map((model) => {
                                            const isSelected = selectedModelId === model.id;
                                            const badges = getModelBadges(model);
                                            return (
                                                <button
                                                    key={model.id}
                                                    onClick={() => setFormData({ ...formData, model: model.id })}
                                                    className={`px-3 py-2.5 rounded-lg border text-left transition-all ${isSelected
                                                        ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                        : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                        }`}
                                                >
                                                    <div className="min-w-0">
                                                        <div className={`text-xs font-medium truncate ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                                                            {model.label}
                                                        </div>
                                                        {model.description && (
                                                            <div className="text-[10px] text-[#8e8ea0] truncate">{model.description}</div>
                                                        )}
                                                        {badges.length > 0 && (
                                                            <div className="mt-1 flex flex-wrap gap-1">
                                                                {badges.map((badge) => (
                                                                    <span
                                                                        key={`${model.id}-${badge}`}
                                                                        className="px-1.5 py-0.5 rounded border border-white/15 bg-[#252525] text-[10px] text-[#b4b4b4]"
                                                                    >
                                                                        {badge}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {reasoningFilteringEnabled && (
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium text-[#b4b4b4] flex items-center gap-1.5">
                                            <Sparkles size={12} />
                                            Thinking / Reasoning Effort
                                        </label>
                                        {!selectedModelSupportsReasoning && (
                                            <p className="text-[11px] text-[#8e8ea0]">
                                                This model does not support configurable reasoning effort. Reasoning is set to Off.
                                            </p>
                                        )}
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                            {REASONING_EFFORT_OPTIONS.map((option) => {
                                                const selectedEffort = formData.reasoningEffort || DEFAULT_REASONING_EFFORT;
                                                const isSelected = selectedEffort === option.id;
                                                const isDisabled = !selectedModelSupportsReasoning && option.id !== "none";
                                                return (
                                                    <button
                                                        key={option.id}
                                                        disabled={isDisabled}
                                                        onClick={() => setFormData({ ...formData, reasoningEffort: option.id })}
                                                        className={`px-3 py-2.5 rounded-lg border text-left transition-all ${isSelected
                                                            ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                            : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                            } ${isDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
                                                    >
                                                        <div className={`text-xs font-medium ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                                                            {option.label}
                                                        </div>
                                                        <div className="text-[10px] text-[#8e8ea0] mt-0.5">{option.description}</div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
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
                                                    className={`px-2.5 py-2 rounded-lg border text-left transition-all ${isSelected
                                                        ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                        : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                        }`}
                                                >
                                                    <div className={`text-xs font-semibold ${isSelected ? "text-white" : "text-[#ececec]"}`}>{p.label}</div>
                                                    <div className="text-[10px] text-[#8e8ea0] truncate">{p.desc}</div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <label className="text-xs font-medium text-[#b4b4b4] flex items-center gap-1.5">
                                            <Volume2 size={12} />
                                            TTS Voice
                                        </label>
                                        {ttsProvider === "elevenlabs" && (
                                            <button
                                                type="button"
                                                onClick={() => void loadElevenLabsVoices({ forceRefresh: true })}
                                                disabled={isRefreshingVoices}
                                                className="px-2.5 py-1 rounded-md border border-[#424242] text-[11px] font-medium text-[#d4d4d8] hover:bg-[#2f2f2f] hover:border-[#676767] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                            >
                                                {isRefreshingVoices ? "Refreshing..." : "Refresh Voices"}
                                            </button>
                                        )}
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[280px] overflow-y-auto pr-1 custom-scrollbar">
                                        {voiceOptions.map((voice) => {
                                            const isSelected = (formData.voiceId || "troy") === voice.id;
                                            return (
                                                <button
                                                    key={voice.id}
                                                    onClick={() => setFormData({ ...formData, voiceId: voice.id })}
                                                    className={`px-3 py-2 rounded-lg border text-left transition-all ${isSelected
                                                        ? "bg-[#10a37f]/10 border-[#10a37f] ring-1 ring-[#10a37f]"
                                                        : "bg-[#2f2f2f] border-[#424242] hover:border-[#676767]"
                                                        }`}
                                                >
                                                    <div className={`text-xs font-semibold truncate ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                                                        {voice.label}
                                                    </div>
                                                    <div className="text-[10px] text-[#8e8ea0] truncate">{voice.desc}</div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
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
                        onClick={() => onSave({ ...formData, reasoningEffort: formData.reasoningEffort || DEFAULT_REASONING_EFFORT })}
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
