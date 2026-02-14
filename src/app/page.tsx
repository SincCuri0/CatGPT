"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useSettings } from "@/hooks/useSettings";
import { AccessPermissionMode, AgentConfig, AgentStyle } from "@/lib/core/Agent";
import { SquadConfig, SquadRunStep, getSquadGoal, getSquadInteractionConfig, normalizeSquadConfig } from "@/lib/core/Squad";
import { Message } from "@/lib/core/types";
import { SettingsModal } from "@/components/SettingsModal";
import { AgentEditor } from "@/components/agent/AgentEditor";
import { SquadEditor } from "@/components/agent/SquadEditor";
import { SquadBlueprintLibraryModal } from "@/components/agent/SquadBlueprintLibraryModal";
import { ChatInterface, SlashCommandOption } from "@/components/ChatInterface";
import defaultAgents from "@/lib/templates/default_agents.json";
import { DEFAULT_SQUAD_BLUEPRINTS } from "@/lib/templates/default_squad_blueprints";
import {
  SquadBlueprintDefinition,
  createBlueprintFromSquad,
  instantiateBlueprint,
  normalizeBlueprintList,
  parseBlueprintText,
  serializeBlueprintForShare,
} from "@/lib/squads/blueprints";
import { Settings, Plus, PawPrint, MessageSquare, PanelLeftClose, MoreHorizontal, Pencil, Trash2, Clock, Users, ListTree, ChevronDown, ChevronRight, Check, BookTemplate, Download, BookmarkPlus, Wrench, Brain } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { getAgentPersonality } from "@/lib/agentPersonality";
import { DEFAULT_REASONING_EFFORT, PROVIDERS, REASONING_EFFORT_OPTIONS } from "@/lib/llm/constants";
import type { ReasoningEffort } from "@/lib/llm/types";
import {
  buildFallbackCatalogProviders,
  defaultModelForCatalogProvider,
  defaultModelForProviderWithRequirements,
  isModelChatCapable,
  supportsReasoningEffort,
  supportsToolUse,
} from "@/lib/llm/modelCatalog";
import {
  Conversation,
  ConversationAgentOverrides,
  SquadTraceTurn,
  loadConversations,
  saveConversations,
  upsertConversation,
  deleteConversation as deleteConv,
  renameConversation,
  generateTitle,
} from "@/lib/conversations";
import { debugClientError, debugClientLog } from "@/lib/debug/client";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { useUserSettings } from "@/hooks/useUserSettings";
import {
  DEFAULT_SIDEBAR_WIDTH,
  clampSidebarWidth,
} from "@/lib/settings/schema";

const TEMPLATE_AGENTS = defaultAgents as AgentConfig[];
const TEMPLATE_DEFAULT_AGENT =
  TEMPLATE_AGENTS.find((agent) => agent.name?.trim().toLowerCase() === "default agent") ||
  TEMPLATE_AGENTS[0];
const SYSTEM_DEFAULT_AGENT_ID = TEMPLATE_DEFAULT_AGENT?.id || "agent_cat_gpt";
const DEFAULT_PROVIDER_ID = "groq";
const DEFAULT_MODEL_ID = "llama-3.3-70b-versatile";
const DEFAULT_VOICE_ID = "en-US-ChristopherNeural";
const CHAT_AGENTS_STORAGE_KEY = "cat_gpt_agents";
const SQUAD_AGENTS_STORAGE_KEY = "cat_gpt_squad_agents";
const SQUADS_STORAGE_KEY = "cat_gpt_squads";
const SQUAD_BLUEPRINTS_STORAGE_KEY = "cat_gpt_squad_blueprints";
const DEFAULT_CHAT_AGENT_OPTION_VALUE = "__default_agent__";
const ACTIVE_SQUAD_OPTION_VALUE = "__active_squad__";
const VALID_AGENT_STYLES = new Set<AgentStyle>(["assistant", "character", "expert", "custom"]);
const ALLOWED_TOOL_IDS = new Set([
  "web_search",
  "fs_read",
  "fs_write",
  "fs_list",
  "shell_execute",
  "mcp_all",
  "sessions_spawn",
  "sessions_await",
  "sessions_list",
  "sessions_cancel",
]);
const PRIVILEGED_TOOL_IDS = new Set([
  "fs_write",
  "shell_execute",
  "write_file",
  "execute_command",
]);
const FALLBACK_LLM_CATALOG = buildFallbackCatalogProviders();

const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

const SLASH_COMMANDS: SlashCommandOption[] = [
  {
    command: "/create_cats",
    description: "Generate one or more new agents from a natural-language request.",
  },
  {
    command: "/create_squad",
    description: "Generate a new squad (with squad-only agents) from a natural-language request.",
  },
];

interface ParsedSlashCommand {
  name: string;
  args: string;
}

interface CreateCatsGeneratedAgent {
  name: string;
  role: string;
  description?: string;
  style?: AgentStyle;
  systemPrompt: string;
  tools?: string[];
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  voiceId?: string;
}

interface CreateCatsSuccessResponse {
  action: "create_agents";
  summary?: string;
  agents: CreateCatsGeneratedAgent[];
}

interface CreateCatsQuestionResponse {
  action: "request_information";
  question: string;
  reason?: string;
}

type CreateCatsApiResponse = CreateCatsSuccessResponse | CreateCatsQuestionResponse;
type AgentCollectionTarget = "chat" | "squad";

interface CreateCatsExecutionResult {
  role: "assistant" | "system";
  content: string;
  createdAgents: AgentConfig[];
}

const parseSlashCommand = (text: string): ParsedSlashCommand | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const [name, ...rest] = trimmed.split(/\s+/);
  return {
    name: name.toLowerCase(),
    args: rest.join(" ").trim(),
  };
};

const defaultModelForProvider = (providerId: string): string => {
  const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
  return provider?.defaultModel || DEFAULT_MODEL_ID;
};

const normalizeReasoningEffort = (value: unknown): ReasoningEffort => {
  if (value === "none" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return DEFAULT_REASONING_EFFORT;
};

const formatCompactTokenCount = (value?: number): string | null => {
  if (typeof value !== "number" || value <= 0) return null;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
};

const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
};

const normalizeAccessMode = (value: unknown): AccessPermissionMode => (
  value === "full_access" ? "full_access" : "ask_always"
);

const hasPrivilegedToolCapability = (tools?: string[]): boolean => (
  Array.isArray(tools) && tools.some((toolId) => (
    PRIVILEGED_TOOL_IDS.has(toolId)
    || toolId === "mcp_all"
  ))
);

const hasAnyToolCapability = (tools?: string[]): boolean => (
  Array.isArray(tools) && tools.length > 0
);

const getModelBadges = (model: {
  capabilities?: {
    chat?: boolean;
    nativeTools?: boolean;
    reasoning?: boolean;
    embeddings?: boolean;
  };
  metadata?: {
    contextWindow?: number;
    maxOutputTokens?: number;
  };
}): string[] => {
  const badges: string[] = [];
  if (model.capabilities?.chat) badges.push("Chat");
  if (model.capabilities?.nativeTools) badges.push("Tools");
  if (model.capabilities?.reasoning) badges.push("Reasoning");
  if (model.capabilities?.embeddings) badges.push("Embeddings");

  const contextWindow = formatCompactTokenCount(model.metadata?.contextWindow);
  if (contextWindow) badges.push(`${contextWindow} ctx`);

  const maxOut = formatCompactTokenCount(model.metadata?.maxOutputTokens);
  if (maxOut) badges.push(`${maxOut} out`);

  return badges;
};

const resolveDefaultAgentId = (agentList: AgentConfig[]): string | null => {
  if (agentList.length === 0) return null;

  const byTemplateId = TEMPLATE_DEFAULT_AGENT?.id
    ? agentList.find((agent) => agent.id === TEMPLATE_DEFAULT_AGENT.id)
    : undefined;
  if (byTemplateId?.id) return byTemplateId.id;

  const byTemplateName = TEMPLATE_DEFAULT_AGENT?.name
    ? agentList.find((agent) => agent.name === TEMPLATE_DEFAULT_AGENT.name)
    : undefined;
  if (byTemplateName?.id) return byTemplateName.id;

  return agentList[0]?.id || null;
};

const normalizeAgentConfig = (agent: AgentConfig): AgentConfig => ({
  ...agent,
  accessMode: normalizeAccessMode(agent.accessMode),
});

const ensureDefaultAgentPresent = (agentList: AgentConfig[]): AgentConfig[] => {
  const list = agentList.map((agent) => normalizeAgentConfig(agent));
  if (!TEMPLATE_DEFAULT_AGENT) return list;

  const templateId = TEMPLATE_DEFAULT_AGENT.id;
  if (templateId && list.some((agent) => agent.id === templateId)) {
    return list;
  }

  const templateName = TEMPLATE_DEFAULT_AGENT.name?.trim().toLowerCase();
  if (templateName) {
    const existingIndex = list.findIndex((agent) => (
      agent.name?.trim().toLowerCase() === templateName
    ));
    if (existingIndex >= 0) {
      const existing = list[existingIndex];
      if (!existing.id && templateId) {
        list[existingIndex] = { ...existing, id: templateId };
      }
      return list;
    }
  }

  return [normalizeAgentConfig(TEMPLATE_DEFAULT_AGENT), ...list];
};

const resolveRequiredDefaultAgentId = (agentList: AgentConfig[]): string => (
  resolveDefaultAgentId(agentList) || SYSTEM_DEFAULT_AGENT_ID
);

const normalizeSquadList = (raw: unknown): SquadConfig[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is SquadConfig => Boolean(entry && typeof entry === "object"))
    .map((entry) => normalizeSquadConfig(entry));
};

const normalizeTraceStatus = (status: unknown): SquadTraceTurn["status"] => {
  const value = String(status || "completed");
  if (value === "in_progress" || value === "needs_user_input" || value === "blocked" || value === "max_iterations") {
    return value;
  }
  return "completed";
};

const getSquadWorkerAgents = (squad: SquadConfig, allAgents: AgentConfig[]): AgentConfig[] => (
  allAgents.filter((agent) => {
    const id = agent.id || "";
    return squad.members.includes(id);
  })
);

const buildSquadOrchestratorAgent = (squad: SquadConfig): AgentConfig => {
  const goal = getSquadGoal(squad);
  return {
    id: `${squad.id || squad.name}-orchestrator`,
    name: squad.orchestrator?.name || "OR",
    role: "Squad Orchestrator",
    systemPrompt: goal || "Coordinate worker agents to complete tasks.",
    style: squad.orchestrator?.style || "assistant",
    voiceId: squad.orchestrator?.voiceId || DEFAULT_VOICE_ID,
    provider: squad.orchestrator?.provider || DEFAULT_PROVIDER_ID,
    model: squad.orchestrator?.model || DEFAULT_MODEL_ID,
    tools: [],
  };
};

export default function CEODashboard() {
  const { apiKey, apiKeys, serverConfiguredKeys, debugLogsEnabled } = useSettings();
  const { providers: modelCatalogProviders } = useModelCatalog();
  const {
    settings: userSettings,
    isLoaded: hasLoadedUserSettings,
    updateSettings: updateUserSettings,
  } = useUserSettings();
  const llmProviders = modelCatalogProviders.length > 0 ? modelCatalogProviders : FALLBACK_LLM_CATALOG;
  const initialAgents = ensureDefaultAgentPresent(TEMPLATE_AGENTS);
  const [agents, setAgents] = useState<AgentConfig[]>(initialAgents);
  const [squadAgents, setSquadAgents] = useState<AgentConfig[]>([]);
  const [squads, setSquads] = useState<SquadConfig[]>([]);
  const hasAnyApiKeyConfigured =
    Object.values(apiKeys).some((k) => Boolean(k && k.trim())) ||
    Object.values(serverConfiguredKeys).some(Boolean);

  // Selection
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    () => resolveRequiredDefaultAgentId(initialAgents),
  );
  const [selectedSquadId, setSelectedSquadId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentMessages, setCurrentMessages] = useState<Message[]>([]);
  const [currentSquadTrace, setCurrentSquadTrace] = useState<SquadTraceTurn[]>([]);
  const [isMasterLogOpen, setIsMasterLogOpen] = useState(false);

  // Modals
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHiringOpen, setIsHiringOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentConfig | undefined>(undefined);
  const [isSquadEditorOpen, setIsSquadEditorOpen] = useState(false);
  const [editingSquad, setEditingSquad] = useState<SquadConfig | undefined>(undefined);
  const [isBlueprintLibraryOpen, setIsBlueprintLibraryOpen] = useState(false);

  // Loading State
  const [isProcessing, setIsProcessing] = useState(false);
  const [masterLogNow, setMasterLogNow] = useState(() => Date.now());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState<string | null>(null);
  const [squadMenuOpen, setSquadMenuOpen] = useState<string | null>(null);
  const [chatMenuOpen, setChatMenuOpen] = useState<string | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [hasLoadedAgents, setHasLoadedAgents] = useState(false);
  const [hasLoadedSquads, setHasLoadedSquads] = useState(false);
  const [hasLoadedConversations, setHasLoadedConversations] = useState(false);
  const [chatSelectorMenuOpen, setChatSelectorMenuOpen] = useState(false);
  const [chatSelectorSubmenu, setChatSelectorSubmenu] = useState<"cat" | "model" | "reasoning" | null>(null);
  const [draftAgentOverrides, setDraftAgentOverrides] = useState<ConversationAgentOverrides | null>(null);
  const [savedSquadBlueprints, setSavedSquadBlueprints] = useState<SquadBlueprintDefinition[]>([]);
  const chatSelectorMenuRef = useRef<HTMLDivElement | null>(null);
  const agentCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const agentMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const squadCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const squadMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const sidebarResizeStartXRef = useRef(0);
  const sidebarResizeStartWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const hasInitializedSidebarWidthRef = useRef(false);
  const [agentMenuPosition, setAgentMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [squadMenuPosition, setSquadMenuPosition] = useState<{ top: number; left: number } | null>(null);

  // Load agents on mount
  useEffect(() => {
    const storedAgents = localStorage.getItem(CHAT_AGENTS_STORAGE_KEY);
    let loadedAgents: AgentConfig[] = [];

    if (storedAgents) {
      try {
        loadedAgents = JSON.parse(storedAgents) as AgentConfig[];
      } catch {
        loadedAgents = TEMPLATE_AGENTS;
      }
    } else {
      loadedAgents = TEMPLATE_AGENTS;
    }

    const normalizedAgents = ensureDefaultAgentPresent(loadedAgents);
    setAgents(normalizedAgents);
    setSelectedAgentId(resolveRequiredDefaultAgentId(normalizedAgents));
    setSelectedSquadId(null);
    setHasLoadedAgents(true);
  }, []);

  // Load squads on mount
  useEffect(() => {
    const storedSquads = localStorage.getItem(SQUADS_STORAGE_KEY);
    if (storedSquads) {
      try {
        setSquads(normalizeSquadList(JSON.parse(storedSquads)));
      } catch {
        setSquads([]);
      }
    } else {
      setSquads([]);
    }
    setHasLoadedSquads(true);
  }, []);

  // Load squad-only agents on mount
  useEffect(() => {
    const storedSquadAgents = localStorage.getItem(SQUAD_AGENTS_STORAGE_KEY);
    if (!storedSquadAgents) {
      setSquadAgents([]);
      return;
    }

    try {
      const parsed = JSON.parse(storedSquadAgents) as AgentConfig[];
      setSquadAgents(Array.isArray(parsed) ? parsed.map((agent) => normalizeAgentConfig(agent)) : []);
    } catch {
      setSquadAgents([]);
    }
  }, []);

  // Load saved squad blueprints on mount
  useEffect(() => {
    const storedBlueprints = localStorage.getItem(SQUAD_BLUEPRINTS_STORAGE_KEY);
    if (!storedBlueprints) {
      setSavedSquadBlueprints([]);
      return;
    }

    try {
      const parsed = JSON.parse(storedBlueprints) as unknown;
      setSavedSquadBlueprints(normalizeBlueprintList(parsed));
    } catch {
      setSavedSquadBlueprints([]);
    }
  }, []);

  // Backward compatibility: migrate legacy squad member IDs from chat agents once.
  useEffect(() => {
    const hasStoredSquadAgents = Boolean(localStorage.getItem(SQUAD_AGENTS_STORAGE_KEY));
    if (hasStoredSquadAgents || squadAgents.length > 0) return;
    if (agents.length === 0 || squads.length === 0) return;

    const legacyMemberIds = new Set(
      squads.flatMap((squad) => (Array.isArray(squad.members) ? squad.members : [])),
    );
    if (legacyMemberIds.size === 0) return;

    const migrated = agents.filter((agent) => {
      const id = agent.id || "";
      return legacyMemberIds.has(id);
    });
    if (migrated.length === 0) return;

    setSquadAgents(migrated);
    localStorage.setItem(SQUAD_AGENTS_STORAGE_KEY, JSON.stringify(migrated));
  }, [agents, squads, squadAgents.length]);

  // Warm ElevenLabs voices cache on app load so voice options are ready in editors.
  useEffect(() => {
    try {
      const cached = localStorage.getItem("cat_gpt_elevenlabs_voices");
      if (cached) {
        const parsed = JSON.parse(cached) as Array<{ id: string; label: string; desc: string }>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          debugClientLog("CEODashboard", "Skipping /api/elevenlabs/voices warmup; using local cache", {
            voiceCount: parsed.length,
          });
          return;
        }
      }
    } catch {
      // ignore cache parse errors and fall through to warm request
    }

    fetch("/api/elevenlabs/voices", {
      headers: debugLogsEnabled ? { "x-debug-logs": "1" } : undefined,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("voice cache warm failed"))))
      .then((data) => {
        if (Array.isArray(data.voices)) {
          localStorage.setItem("cat_gpt_elevenlabs_voices", JSON.stringify(
            data.voices.map((voice: { id: string; label: string; gender?: string }) => ({
              id: voice.id,
              label: voice.label,
              desc: `${voice.gender || "neutral"} (ElevenLabs)`,
            }))
          ));
        }
      })
      .catch(() => undefined);
  }, [debugLogsEnabled]);

  // Load ALL conversations on mount
  useEffect(() => {
    setConversations(loadConversations().sort((a, b) => b.updatedAt - a.updatedAt));
    setHasLoadedConversations(true);
  }, []);

  // Load messages when active conversation changes
  useEffect(() => {
    if (activeConversationId) {
      const allConvos = loadConversations();
      const conv = allConvos.find(c => c.id === activeConversationId);
      setCurrentMessages(conv?.messages || []);
      setCurrentSquadTrace(conv?.squadTrace || []);
    } else {
      setCurrentMessages([]);
      setCurrentSquadTrace([]);
    }
  }, [activeConversationId]);

  useEffect(() => {
    if (!chatSelectorMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!chatSelectorMenuRef.current) return;
      if (chatSelectorMenuRef.current.contains(event.target as Node)) return;
      setChatSelectorMenuOpen(false);
      setChatSelectorSubmenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setChatSelectorMenuOpen(false);
      setChatSelectorSubmenu(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [chatSelectorMenuOpen]);

  const updateAgentMenuPosition = useCallback((agentId: string | null) => {
    if (!agentId || typeof window === "undefined") {
      setAgentMenuPosition(null);
      return;
    }

    const row = agentCardRefs.current[agentId];
    if (!row) {
      setAgentMenuPosition(null);
      return;
    }

    const rect = row.getBoundingClientRect();
    const gap = 8;
    const menuWidth = 180;
    const menuHeight = 84;
    const viewportPadding = 8;

    let left = rect.right + gap;
    if (left + menuWidth > window.innerWidth - viewportPadding) {
      left = Math.max(viewportPadding, rect.left - menuWidth - gap);
    }

    let top = rect.top;
    if (top + menuHeight > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding);
    }

    setAgentMenuPosition({
      left: Math.round(left),
      top: Math.round(top),
    });
  }, []);

  const updateSquadMenuPosition = useCallback((squadId: string | null) => {
    if (!squadId || typeof window === "undefined") {
      setSquadMenuPosition(null);
      return;
    }

    const row = squadCardRefs.current[squadId];
    if (!row) {
      setSquadMenuPosition(null);
      return;
    }

    const rect = row.getBoundingClientRect();
    const gap = 8;
    const menuWidth = 220;
    const menuHeight = 144;
    const viewportPadding = 8;

    let left = rect.right + gap;
    if (left + menuWidth > window.innerWidth - viewportPadding) {
      left = Math.max(viewportPadding, rect.left - menuWidth - gap);
    }

    let top = rect.top;
    if (top + menuHeight > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding);
    }

    setSquadMenuPosition({
      left: Math.round(left),
      top: Math.round(top),
    });
  }, []);

  useEffect(() => {
    if (!agentMenuOpen) {
      setAgentMenuPosition(null);
      return;
    }

    const sync = () => updateAgentMenuPosition(agentMenuOpen);
    sync();

    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [agentMenuOpen, sidebarWidth, updateAgentMenuPosition]);

  useEffect(() => {
    if (!squadMenuOpen) {
      setSquadMenuPosition(null);
      return;
    }

    const sync = () => updateSquadMenuPosition(squadMenuOpen);
    sync();

    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [squadMenuOpen, sidebarWidth, updateSquadMenuPosition]);

  useEffect(() => {
    if (!agentMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (agentMenuPanelRef.current?.contains(target)) return;
      const row = agentCardRefs.current[agentMenuOpen];
      if (row?.contains(target)) return;
      setAgentMenuOpen(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAgentMenuOpen(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [agentMenuOpen]);

  useEffect(() => {
    if (!squadMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (squadMenuPanelRef.current?.contains(target)) return;
      const row = squadCardRefs.current[squadMenuOpen];
      if (row?.contains(target)) return;
      setSquadMenuOpen(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSquadMenuOpen(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [squadMenuOpen]);

  useEffect(() => {
    if (!isProcessing) {
      setMasterLogNow(Date.now());
      return;
    }

    const timer = window.setInterval(() => {
      setMasterLogNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isProcessing]);

  useEffect(() => {
    if (!hasLoadedUserSettings) return;
    if (isResizingSidebar) return;
    if (hasInitializedSidebarWidthRef.current) return;
    setSidebarWidth(userSettings.ui.sidebarWidth);
    hasInitializedSidebarWidthRef.current = true;
  }, [hasLoadedUserSettings, isResizingSidebar, userSettings.ui.sidebarWidth]);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - sidebarResizeStartXRef.current;
      const nextWidth = clampSidebarWidth(sidebarResizeStartWidthRef.current + delta);
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    if (!hasLoadedUserSettings) return;
    if (isResizingSidebar) return;
    if (sidebarWidth === userSettings.ui.sidebarWidth) return;

    const timer = window.setTimeout(() => {
      void updateUserSettings({
        ui: {
          sidebarWidth,
        },
      });
    }, 150);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    hasLoadedUserSettings,
    isResizingSidebar,
    sidebarWidth,
    updateUserSettings,
    userSettings.ui.sidebarWidth,
  ]);

  const saveAgents = (newAgents: AgentConfig[]) => {
    const normalizeRuntimeAgentConfig = (agent: AgentConfig): AgentConfig => {
      const normalized = normalizeAgentConfig(agent);
      const providerId = (normalized.provider || DEFAULT_PROVIDER_ID).trim().toLowerCase();
      const tools = Array.isArray(normalized.tools) ? normalized.tools : [];
      const modelId = resolveCompatibleRuntimeModel(providerId, normalized.model, tools);
      const requestedReasoning = normalizeReasoningEffort(normalized.reasoningEffort || DEFAULT_REASONING_EFFORT);
      const reasoningEffort = supportsReasoningEffort(providerId, modelId) ? requestedReasoning : "none";
      return {
        ...normalized,
        provider: providerId,
        model: modelId,
        reasoningEffort,
        tools,
      };
    };
    const normalizedAgents = ensureDefaultAgentPresent(newAgents).map((agent) => normalizeRuntimeAgentConfig(agent));
    setAgents(normalizedAgents);
    localStorage.setItem(CHAT_AGENTS_STORAGE_KEY, JSON.stringify(normalizedAgents));
  };

  const saveSquadAgents = (newAgents: AgentConfig[]) => {
    const normalizedAgents = newAgents.map((agent) => {
      const normalized = normalizeAgentConfig(agent);
      const providerId = (normalized.provider || DEFAULT_PROVIDER_ID).trim().toLowerCase();
      const tools = Array.isArray(normalized.tools) ? normalized.tools : [];
      const modelId = resolveCompatibleRuntimeModel(providerId, normalized.model, tools);
      const requestedReasoning = normalizeReasoningEffort(normalized.reasoningEffort || DEFAULT_REASONING_EFFORT);
      const reasoningEffort = supportsReasoningEffort(providerId, modelId) ? requestedReasoning : "none";
      return {
        ...normalized,
        provider: providerId,
        model: modelId,
        reasoningEffort,
        tools,
      };
    });
    setSquadAgents(normalizedAgents);
    localStorage.setItem(SQUAD_AGENTS_STORAGE_KEY, JSON.stringify(normalizedAgents));
  };

  const saveSquads = (newSquads: SquadConfig[]) => {
    const normalized = normalizeSquadList(newSquads);
    setSquads(normalized);
    localStorage.setItem(SQUADS_STORAGE_KEY, JSON.stringify(normalized));
  };

  const saveSquadBlueprints = (newBlueprints: SquadBlueprintDefinition[]) => {
    const normalized = normalizeBlueprintList(newBlueprints);
    setSavedSquadBlueprints(normalized);
    localStorage.setItem(SQUAD_BLUEPRINTS_STORAGE_KEY, JSON.stringify(normalized));
  };

  const refreshConversations = () => {
    setConversations(loadConversations().sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const persistConversationList = (items: Conversation[]) => {
    const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
    saveConversations(sorted);
    setConversations(sorted);
  };

  const reassignConversations = (sourceParticipantId: string, targetAgentId: string) => {
    const allConversations = loadConversations();
    let changed = false;
    const updated = allConversations.map((conversation) => {
      if (conversation.agentId !== sourceParticipantId) {
        return conversation;
      }
      changed = true;
      return {
        ...conversation,
        agentId: targetAgentId,
        agentOverrides: undefined,
      };
    });
    if (changed) {
      persistConversationList(updated);
    }
  };

  const assignConversationToAgent = (conversationId: string, targetAgentId: string) => {
    const allConversations = loadConversations();
    let changed = false;
    const updated = allConversations.map((conversation) => {
      if (conversation.id !== conversationId || conversation.agentId === targetAgentId) {
        return conversation;
      }
      changed = true;
      return {
        ...conversation,
        agentId: targetAgentId,
        agentOverrides: undefined,
      };
    });
    if (changed) {
      persistConversationList(updated);
    }
  };

  useEffect(() => {
    if (agents.some((agent) => agent.id === selectedAgentId)) return;
    setSelectedAgentId(resolveRequiredDefaultAgentId(agents));
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (!hasLoadedAgents || !hasLoadedSquads || !hasLoadedConversations) return;

    const defaultAgentId = resolveRequiredDefaultAgentId(agents);

    const knownAgentIds = new Set(
      agents
        .map((agent) => agent.id)
        .filter((id): id is string => Boolean(id)),
    );
    const knownSquadIds = new Set(
      squads
        .map((squad) => squad.id)
        .filter((id): id is string => Boolean(id)),
    );

    let changed = false;
    const updatedConversations = conversations.map((conversation) => {
      if (knownAgentIds.has(conversation.agentId) || knownSquadIds.has(conversation.agentId)) {
        return conversation;
      }
      changed = true;
      return {
        ...conversation,
        agentId: defaultAgentId,
        agentOverrides: undefined,
      };
    });

    if (!changed) return;

    const sortedUpdatedConversations = [...updatedConversations].sort((a, b) => b.updatedAt - a.updatedAt);
    saveConversations(sortedUpdatedConversations);
    setConversations(sortedUpdatedConversations);

    if (activeConversationId) {
      const activeConversation = updatedConversations.find((conversation) => conversation.id === activeConversationId);
      if (activeConversation?.agentId === defaultAgentId) {
        setSelectedAgentId(defaultAgentId);
        setSelectedSquadId(null);
      }
    }
  }, [
    activeConversationId,
    agents,
    conversations,
    hasLoadedAgents,
    hasLoadedConversations,
    hasLoadedSquads,
    squads,
  ]);

  const hasProviderKeyConfigured = (providerId: string): boolean => {
    const localKey = apiKeys[providerId];
    if (typeof localKey === "string" && localKey.trim().length > 0) return true;

    const envKey = PROVIDER_ENV_KEY_MAP[providerId];
    if (envKey && serverConfiguredKeys[envKey]) return true;
    if (serverConfiguredKeys[providerId]) return true;
    return false;
  };
  const isSupportedRuntimeProvider = (providerId: string): boolean => (
    llmProviders.some((provider) => provider.id === providerId)
  );
  const defaultRuntimeModelForProvider = (
    providerId: string,
    requirements?: { requireToolUse?: boolean; requireReasoning?: boolean },
  ): string => {
    const provider = llmProviders.find((candidate) => candidate.id === providerId);
    if (!provider) return defaultModelForProvider(providerId);
    const needsCapabilityModel = Boolean(requirements?.requireToolUse || requirements?.requireReasoning);
    return needsCapabilityModel
      ? defaultModelForProviderWithRequirements(provider, requirements)
      : defaultModelForCatalogProvider(provider);
  };
  const resolveCompatibleRuntimeModel = (
    providerId: string,
    requestedModel: string | undefined,
    tools?: string[],
  ): string => {
    const requireToolUse = hasAnyToolCapability(tools);
    const fallbackModel = defaultRuntimeModelForProvider(providerId, { requireToolUse });
    const candidate = (requestedModel || "").trim();
    if (!candidate) return fallbackModel;

    const chatCapable = isModelChatCapable({ id: candidate }, providerId);
    if (!chatCapable) return fallbackModel;
    if (requireToolUse && !supportsToolUse(providerId, candidate)) return fallbackModel;
    return candidate;
  };

  const resolveCreateCatsProvider = (
    preferredProvider?: string,
    preferredModel?: string,
    preferredReasoningEffort?: ReasoningEffort,
  ): { provider: string; model: string; reasoningEffort: ReasoningEffort } => {
    const providerIds = llmProviders.map((provider) => provider.id);
    const normalizedPreferred = (preferredProvider || "").trim().toLowerCase();
    const searchOrder = [
      ...(normalizedPreferred ? [normalizedPreferred] : []),
      ...providerIds.filter((providerId) => providerId !== normalizedPreferred),
    ];

    const providerWithKey = searchOrder.find((providerId) => hasProviderKeyConfigured(providerId));
    const provider = providerWithKey || DEFAULT_PROVIDER_ID;
    const preferredModelId = preferredModel?.trim() || "";
    const preferredModelIsChatCapable = preferredModelId
      ? isModelChatCapable({ id: preferredModelId }, provider)
      : false;
    const model = provider === normalizedPreferred && preferredModelId && preferredModelIsChatCapable
      ? preferredModelId
      : defaultRuntimeModelForProvider(provider);
    const reasoningEffort = normalizeReasoningEffort(preferredReasoningEffort);

    return { provider, model, reasoningEffort };
  };

  const resolveImportProviderModel = (
    preferredProvider?: string,
    preferredModel?: string,
    preferredReasoningEffort?: ReasoningEffort,
  ): { provider: string; model: string; reasoningEffort?: ReasoningEffort } => {
    const normalizedPreferredProvider = (preferredProvider || "").trim().toLowerCase();
    const preferredProviderSupported = normalizedPreferredProvider
      ? isSupportedRuntimeProvider(normalizedPreferredProvider)
      : false;
    const preferredProviderHasKey = preferredProviderSupported
      ? hasProviderKeyConfigured(normalizedPreferredProvider)
      : false;
    const firstProviderWithKey = llmProviders.find((provider) => hasProviderKeyConfigured(provider.id))?.id;

    let provider = DEFAULT_PROVIDER_ID;
    if (preferredProviderHasKey) {
      provider = normalizedPreferredProvider;
    } else if (firstProviderWithKey) {
      provider = firstProviderWithKey;
    } else if (preferredProviderSupported) {
      provider = normalizedPreferredProvider;
    } else if (llmProviders[0]?.id) {
      provider = llmProviders[0].id;
    }

    if (!isSupportedRuntimeProvider(provider) && llmProviders[0]?.id) {
      provider = llmProviders[0].id;
    }

    const preferredModelId = (preferredModel || "").trim();
    const usePreferredModel = preferredModelId.length > 0 && isModelChatCapable({ id: preferredModelId }, provider);
    const model = usePreferredModel ? preferredModelId : defaultRuntimeModelForProvider(provider);

    if (!preferredReasoningEffort) {
      return { provider, model };
    }
    const normalizedReasoning = normalizeReasoningEffort(preferredReasoningEffort);
    const reasoningEffort = supportsReasoningEffort(provider, model)
      ? normalizedReasoning
      : "none";
    return { provider, model, reasoningEffort };
  };

  const makeUniqueAgentName = (requestedName: string, takenNames: Set<string>): string => {
    const baseName = requestedName.trim() || "New Cat";
    if (!takenNames.has(baseName.toLowerCase())) {
      takenNames.add(baseName.toLowerCase());
      return baseName;
    }

    let suffix = 2;
    while (true) {
      const candidate = `${baseName} ${suffix}`;
      const normalized = candidate.toLowerCase();
      if (!takenNames.has(normalized)) {
        takenNames.add(normalized);
        return candidate;
      }
      suffix += 1;
    }
  };

  const makeUniqueSquadName = (requestedName: string, takenNames: Set<string>): string => {
    const baseName = requestedName.trim() || "New Squad";
    if (!takenNames.has(baseName.toLowerCase())) {
      takenNames.add(baseName.toLowerCase());
      return baseName;
    }

    let suffix = 2;
    while (true) {
      const candidate = `${baseName} ${suffix}`;
      const normalized = candidate.toLowerCase();
      if (!takenNames.has(normalized)) {
        takenNames.add(normalized);
        return candidate;
      }
      suffix += 1;
    }
  };

  const buildSquadNameFromPrompt = (prompt: string): string => {
    const cleaned = prompt.trim().replace(/^["']+|["']+$/g, "");
    if (!cleaned) return "New Squad";

    const words = cleaned
      .replace(/[^a-zA-Z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return "New Squad";

    const leadingIntentVerbs = new Set([
      "build",
      "create",
      "make",
      "develop",
      "design",
      "ship",
      "plan",
      "launch",
      "write",
    ]);
    const coreWords = words.length > 2 && leadingIntentVerbs.has(words[0].toLowerCase())
      ? words.slice(1)
      : words;
    const title = coreWords
      .slice(0, 4)
      .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");

    if (!title) return "New Squad";
    if (title.toLowerCase().endsWith(" squad")) return title;
    return `${title} Squad`;
  };

  const executeCreateCatsCommand = async (
    prompt: string,
    preferredProvider?: string,
    preferredModel?: string,
    preferredReasoningEffort?: ReasoningEffort,
    targetCollection: AgentCollectionTarget = "chat",
  ): Promise<CreateCatsExecutionResult> => {
    const existingAgentPool = targetCollection === "squad" ? squadAgents : agents;
    const { provider, model, reasoningEffort } = resolveCreateCatsProvider(
      preferredProvider,
      preferredModel,
      preferredReasoningEffort,
    );
    debugClientLog("page", "Requesting /api/agents/create-cats", {
      provider,
      model,
      reasoningEffort,
      targetCollection,
      promptLength: prompt.length,
    });
    const response = await fetch("/api/agents/create-cats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-groq-api-key": apiKey || "",
        "x-api-keys": JSON.stringify(apiKeys),
        ...(debugLogsEnabled ? { "x-debug-logs": "1" } : {}),
      },
      body: JSON.stringify({
        prompt,
        provider,
        model,
        reasoningEffort,
        existingAgents: existingAgentPool.map((agent) => ({
          name: agent.name,
          role: agent.role,
        })),
      }),
    });

    const data = await response.json() as (CreateCatsApiResponse & { error?: string; details?: string });
    debugClientLog("page", "Received /api/agents/create-cats response", {
      ok: response.ok,
      status: response.status,
      action: (data as CreateCatsApiResponse).action,
    });
    if (!response.ok || data.error) {
      throw new Error(data.error || data.details || "Failed to run /create_cats.");
    }

    if (data.action === "request_information") {
      return {
        role: "assistant",
        content: data.question.trim() || "Please share what you want these new cat agents to do.",
        createdAgents: [],
      };
    }

    const generatedAgents = Array.isArray(data.agents) ? data.agents : [];
    if (generatedAgents.length === 0) {
      return {
        role: "assistant",
        content: "I couldn't generate any usable agent instructions yet. Tell me what responsibilities these cats should cover.",
        createdAgents: [],
      };
    }

    const takenNames = new Set(existingAgentPool.map((agent) => (agent.name || "").toLowerCase()));
    const createdAgents: AgentConfig[] = generatedAgents.map((generated, index) => {
      const requestedName = typeof generated.name === "string" ? generated.name : "";
      const name = makeUniqueAgentName(requestedName || `New Cat ${index + 1}`, takenNames);
      const role = (typeof generated.role === "string" && generated.role.trim())
        ? generated.role.trim()
        : "Assistant";
      const description = typeof generated.description === "string" ? generated.description.trim() : "";
      const style = typeof generated.style === "string" && VALID_AGENT_STYLES.has(generated.style as AgentStyle)
        ? generated.style as AgentStyle
        : "assistant";
      const providerId = typeof generated.provider === "string" && generated.provider.trim()
        ? generated.provider.trim().toLowerCase()
        : provider;
      const resolvedProvider = isSupportedRuntimeProvider(providerId)
        ? providerId
        : provider;
      const tools = Array.isArray(generated.tools)
        ? generated.tools
          .filter((tool): tool is string => typeof tool === "string")
          .map((tool) => tool.trim())
          .filter((tool) => Boolean(tool) && ALLOWED_TOOL_IDS.has(tool))
        : [];
      const requestedModel = (typeof generated.model === "string" && generated.model.trim())
        ? generated.model.trim()
        : "";
      const safeModel = resolveCompatibleRuntimeModel(
        resolvedProvider,
        requestedModel || undefined,
        tools,
      );
      const resolvedReasoningEffort = typeof generated.reasoningEffort === "string"
        ? normalizeReasoningEffort(generated.reasoningEffort)
        : reasoningEffort;
      const safeReasoningEffort = supportsReasoningEffort(resolvedProvider, safeModel)
        ? resolvedReasoningEffort
        : "none";
      const systemPromptRaw = typeof generated.systemPrompt === "string" ? generated.systemPrompt.trim() : "";
      const systemPrompt = systemPromptRaw || [
        `You are ${name}, a ${role}.`,
        "",
        "Behavior:",
        `- Help with this mission: ${prompt.trim() || "Support the user effectively."}`,
        "- Be clear, practical, and concise.",
        "- Ask clarifying questions only when critical details are missing.",
      ].join("\n");
      const voiceId = (typeof generated.voiceId === "string" && generated.voiceId.trim())
        ? generated.voiceId.trim()
        : DEFAULT_VOICE_ID;

      return {
        id: uuidv4(),
        name,
        role,
        description: description.slice(0, 120),
        style,
        systemPrompt,
        provider: resolvedProvider,
        model: safeModel,
        reasoningEffort: safeReasoningEffort,
        voiceId,
        tools,
        accessMode: "ask_always",
      };
    });

    const updatedAgents = [...existingAgentPool, ...createdAgents];
    if (targetCollection === "squad") {
      saveSquadAgents(updatedAgents);
    } else {
      saveAgents(updatedAgents);
    }

    const summary = typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim()
      : `Created ${createdAgents.length} new cat agent${createdAgents.length > 1 ? "s" : ""}.`;
    const collectionLabel = targetCollection === "squad" ? "squad roster" : "litter";
    const createdList = createdAgents
      .map((agent) => `- **${agent.name}** (${agent.role})`)
      .join("\n");

    return {
      role: "assistant",
      content: `${summary}\n\nAdded to your ${collectionLabel}:\n${createdList}`,
      createdAgents,
    };
  };

  const executeCreateSquadsCommand = async (
    prompt: string,
    preferredProvider?: string,
    preferredModel?: string,
    preferredReasoningEffort?: ReasoningEffort,
  ): Promise<CreateCatsExecutionResult> => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return {
        role: "assistant",
        content: "What should the new squad accomplish? Describe the goal and the specialist cats you want.",
        createdAgents: [],
      };
    }

    const creationResult = await executeCreateCatsCommand(
      trimmedPrompt,
      preferredProvider,
      preferredModel,
      preferredReasoningEffort,
      "squad",
    );
    if (creationResult.createdAgents.length === 0) {
      return creationResult;
    }

    const takenSquadNames = new Set(
      squads
        .map((squad) => (squad.name || "").trim().toLowerCase())
        .filter(Boolean),
    );
    const squadName = makeUniqueSquadName(buildSquadNameFromPrompt(trimmedPrompt), takenSquadNames);
    const memberIds = creationResult.createdAgents
      .map((agent) => agent.id)
      .filter((id): id is string => Boolean(id));

    const firstCreatedAgent = creationResult.createdAgents[0];
    const orchestratorCompatibility = resolveImportProviderModel(
      firstCreatedAgent?.provider || preferredProvider || DEFAULT_PROVIDER_ID,
      firstCreatedAgent?.model || preferredModel,
    );
    const createdSquad = normalizeSquadConfig({
      id: uuidv4(),
      name: squadName,
      goal: trimmedPrompt,
      mission: trimmedPrompt,
      context: "",
      members: memberIds,
      maxIterations: 6,
      accessMode: "ask_always",
      orchestrator: {
        name: "OR",
        provider: orchestratorCompatibility.provider,
        model: orchestratorCompatibility.model,
        style: "assistant",
        voiceId: DEFAULT_VOICE_ID,
      },
    });

    saveSquads([...squads, createdSquad]);
    setSelectedSquadId(createdSquad.id || null);
    setSelectedAgentId(resolveRequiredDefaultAgentId(agents));
    setDraftAgentOverrides(null);

    const createdList = creationResult.createdAgents
      .map((agent) => `- **${agent.name}** (${agent.role})`)
      .join("\n");

    return {
      role: "assistant",
      content: [
        `Created squad **${createdSquad.name}** with ${creationResult.createdAgents.length} new squad cat${creationResult.createdAgents.length > 1 ? "s" : ""}.`,
        "",
        `Goal: ${getSquadGoal(createdSquad)}`,
        "",
        "Members:",
        createdList,
      ].join("\n"),
      createdAgents: creationResult.createdAgents,
    };
  };

  const executeSlashCommand = async (
    command: ParsedSlashCommand,
    targetAgent?: AgentConfig,
    targetSquad?: SquadConfig,
  ): Promise<{ role: "assistant" | "system"; content: string }> => {
    const squadAnchor = targetSquad
      ? getSquadWorkerAgents(targetSquad, squadAgents)[0]
      : undefined;
    const providerHint = targetAgent?.provider || targetSquad?.orchestrator?.provider || squadAnchor?.provider;
    const modelHint = targetAgent?.model || targetSquad?.orchestrator?.model || squadAnchor?.model;
    const reasoningHint = targetAgent?.reasoningEffort || squadAnchor?.reasoningEffort;

    if (command.name === "/create_cats") {
      return executeCreateCatsCommand(
        command.args,
        providerHint,
        modelHint,
        reasoningHint,
      );
    }

    if (command.name === "/create_squad") {
      return executeCreateSquadsCommand(
        command.args,
        providerHint,
        modelHint,
        reasoningHint,
      );
    }

    const commandList = SLASH_COMMANDS.map((entry) => entry.command).join(", ");
    return {
      role: "system",
      content: `Unknown slash command: ${command.name}\n\nAvailable commands: ${commandList}`,
    };
  };

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setSelectedSquadId(null);
    setDraftAgentOverrides(null);
    setAgentMenuOpen(null);
    setSquadMenuOpen(null);
    setChatMenuOpen(null);
    // Start fresh (no active conversation — shows agent landing page)
    setActiveConversationId(null);
    setCurrentMessages([]);
    setCurrentSquadTrace([]);
    setIsMasterLogOpen(false);
    setChatSelectorMenuOpen(false);
    setChatSelectorSubmenu(null);
  };

  const handleSelectSquad = (squadId: string) => {
    setSelectedSquadId(squadId);
    setDraftAgentOverrides(null);
    setAgentMenuOpen(null);
    setSquadMenuOpen(null);
    setChatMenuOpen(null);
    setActiveConversationId(null);
    setCurrentMessages([]);
    setCurrentSquadTrace([]);
    setChatSelectorMenuOpen(false);
    setChatSelectorSubmenu(null);
  };

  const handleNewChat = () => {
    setActiveConversationId(null);
    setCurrentMessages([]);
    setCurrentSquadTrace([]);
    setSquadMenuOpen(null);
    setChatMenuOpen(null);
    setIsMasterLogOpen(false);
    setSelectedSquadId(null);
    setSelectedAgentId(resolveRequiredDefaultAgentId(agents));
    setDraftAgentOverrides(null);
    setChatSelectorMenuOpen(false);
    setChatSelectorSubmenu(null);
  };

  const handleSelectConversation = (convId: string) => {
    const conv = conversations.find(c => c.id === convId);
    if (conv) {
      let found = false;
      const linkedAgent = agents.find((a) => a.id === conv.agentId);
      if (linkedAgent) {
        setSelectedAgentId(linkedAgent.id || resolveRequiredDefaultAgentId(agents));
        setSelectedSquadId(null);
        found = true;
      } else {
        const linkedSquad = squads.find((s) => s.id === conv.agentId);
        if (linkedSquad) {
          setSelectedSquadId(linkedSquad.id || null);
          setSelectedAgentId(resolveRequiredDefaultAgentId(agents));
          found = true;
        }
      }
      if (!found) {
        const defaultAgentId = resolveRequiredDefaultAgentId(agents);
        assignConversationToAgent(conv.id, defaultAgentId);
        setSelectedAgentId(defaultAgentId);
        setSelectedSquadId(null);
      }
    }
    setActiveConversationId(convId);
    setDraftAgentOverrides(null);
    setSquadMenuOpen(null);
    setChatMenuOpen(null);
    setChatSelectorMenuOpen(false);
    setChatSelectorSubmenu(null);
  };

  const handleDeleteConversation = (convId: string) => {
    const conv = conversations.find(c => c.id === convId);
    const confirmed = window.confirm(`Delete "${conv?.title || "this chat"}"? 🗑️`);
    if (confirmed) {
      deleteConv(convId);
      if (activeConversationId === convId) {
        setActiveConversationId(null);
        setCurrentMessages([]);
        setCurrentSquadTrace([]);
        setIsMasterLogOpen(false);
      }
      refreshConversations();
    }
    setChatMenuOpen(null);
  };

  const handleRenameConversation = (convId: string, newTitle: string) => {
    if (newTitle.trim()) {
      renameConversation(convId, newTitle.trim());
      refreshConversations();
    }
    setRenamingChatId(null);
    setChatMenuOpen(null);
  };

  const handleEditSquad = (squad: SquadConfig) => {
    setEditingSquad(squad);
    setIsSquadEditorOpen(true);
    setSquadMenuOpen(null);
  };

  const sanitizeBlueprintFileName = (name: string): string => {
    const safe = name
      .toLowerCase()
      .replace(/[^a-z0-9 -_]+/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return safe || "squad-blueprint";
  };

  const downloadBlueprint = (blueprint: SquadBlueprintDefinition) => {
    const payload = serializeBlueprintForShare(blueprint);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sanitizeBlueprintFileName(blueprint.name)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const importBlueprintBatch = (incomingBlueprints: SquadBlueprintDefinition[]): { importedCount: number; lastSquadId: string | null } => {
    if (incomingBlueprints.length === 0) {
      return { importedCount: 0, lastSquadId: null };
    }

    let nextSquadAgents = [...squadAgents];
    let nextSquads = [...squads];
    let importedCount = 0;
    let lastSquadId: string | null = null;

    for (const blueprint of incomingBlueprints) {
      const { agents: importedAgents, squad: importedSquad } = instantiateBlueprint(blueprint, {
        existingSquadAgents: nextSquadAgents,
        existingSquads: nextSquads,
        createId: uuidv4,
      });

      const normalizedImportedAgents = importedAgents.map((agent) => {
        const preferredProvider = agent.provider || importedSquad.orchestrator?.provider || DEFAULT_PROVIDER_ID;
        const preferredModel = agent.model || importedSquad.orchestrator?.model;
        const compatibility = resolveImportProviderModel(
          preferredProvider,
          preferredModel,
          agent.reasoningEffort,
        );
        return {
          ...agent,
          provider: compatibility.provider,
          model: compatibility.model,
          reasoningEffort: compatibility.reasoningEffort ?? agent.reasoningEffort,
          accessMode: normalizeAccessMode(agent.accessMode),
        };
      });

      const orchestratorCompatibility = resolveImportProviderModel(
        importedSquad.orchestrator?.provider || normalizedImportedAgents[0]?.provider || DEFAULT_PROVIDER_ID,
        importedSquad.orchestrator?.model,
      );
      const normalizedImportedSquad = normalizeSquadConfig({
        ...importedSquad,
        orchestrator: {
          ...importedSquad.orchestrator,
          provider: orchestratorCompatibility.provider,
          model: orchestratorCompatibility.model,
        },
      });

      nextSquadAgents = [...nextSquadAgents, ...normalizedImportedAgents];
      nextSquads = [...nextSquads, normalizedImportedSquad];
      importedCount += 1;
      lastSquadId = normalizedImportedSquad.id || null;
    }

    saveSquadAgents(nextSquadAgents);
    saveSquads(nextSquads);

    if (lastSquadId) {
      handleSelectSquad(lastSquadId);
    }

    return { importedCount, lastSquadId };
  };

  const handleImportBlueprint = (blueprint: SquadBlueprintDefinition) => {
    importBlueprintBatch([blueprint]);
  };

  const handleImportBlueprintJson = (jsonText: string): { importedCount: number } => {
    const parsed = parseBlueprintText(jsonText);
    const result = importBlueprintBatch(parsed);
    return { importedCount: result.importedCount };
  };

  const handleDeleteSavedBlueprint = (blueprintId: string) => {
    const target = savedSquadBlueprints.find((blueprint) => blueprint.id === blueprintId);
    const confirmed = window.confirm(`Remove saved blueprint "${target?.name || blueprintId}"?`);
    if (!confirmed) return;
    saveSquadBlueprints(savedSquadBlueprints.filter((blueprint) => blueprint.id !== blueprintId));
  };

  const handleSaveSquadAsBlueprint = (squad: SquadConfig) => {
    const normalizedSquad = normalizeSquadConfig(squad);
    const members = getSquadWorkerAgents(normalizedSquad, squadAgents);
    if (members.length === 0) {
      window.alert("This squad has no valid members to save as a blueprint.");
      setSquadMenuOpen(null);
      return;
    }

    const suggestedName = `${normalizedSquad.name} Blueprint`;
    const requestedName = window.prompt("Save as Squad Blueprint", suggestedName);
    if (!requestedName || !requestedName.trim()) {
      setSquadMenuOpen(null);
      return;
    }

    const blueprint = createBlueprintFromSquad(normalizedSquad, members, {
      id: `custom-${uuidv4()}`,
      name: requestedName.trim(),
      description: normalizedSquad.goal || `${normalizedSquad.name} workflow blueprint.`,
      category: "Custom",
      author: "Local User",
    });

    if (!blueprint) {
      window.alert("Failed to create blueprint from this squad.");
      setSquadMenuOpen(null);
      return;
    }

    saveSquadBlueprints([...savedSquadBlueprints, blueprint]);
    setSquadMenuOpen(null);
    setIsBlueprintLibraryOpen(true);
  };

  const handleExportSquadBlueprint = (squad: SquadConfig) => {
    const normalizedSquad = normalizeSquadConfig(squad);
    const members = getSquadWorkerAgents(normalizedSquad, squadAgents);
    if (members.length === 0) {
      window.alert("This squad has no valid members to export.");
      setSquadMenuOpen(null);
      return;
    }

    const blueprint = createBlueprintFromSquad(normalizedSquad, members, {
      id: `export-${uuidv4()}`,
      name: `${normalizedSquad.name} Blueprint`,
      description: normalizedSquad.goal || `${normalizedSquad.name} workflow blueprint.`,
      category: "Exported",
      author: "Local Export",
    });

    if (!blueprint) {
      window.alert("Failed to export this squad as a blueprint.");
      setSquadMenuOpen(null);
      return;
    }

    downloadBlueprint(blueprint);
    setSquadMenuOpen(null);
  };

  const handleDeleteAgent = (agent: AgentConfig) => {
    const confirmed = window.confirm(`Release ${agent.name} back into the wild? 🐈`);
    if (!confirmed) {
      setAgentMenuOpen(null);
      return;
    }

    const updatedAgents = agents.filter((candidate) => candidate.id !== agent.id);
    const fallbackAgentId = resolveRequiredDefaultAgentId(updatedAgents);

    saveAgents(updatedAgents);

    if (agent.id) {
      reassignConversations(agent.id, fallbackAgentId);
    }

    const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
    const removedAgentWasActiveConversationTarget = Boolean(activeConversation && activeConversation.agentId === agent.id);

    if (selectedAgentId === agent.id || removedAgentWasActiveConversationTarget) {
      setSelectedAgentId(fallbackAgentId);
      setSelectedSquadId(null);
      setIsMasterLogOpen(false);
    }

    setAgentMenuOpen(null);
  };

  const handleDeleteSquad = (squad: SquadConfig) => {
    const confirmed = window.confirm(`Disband squad "${squad.name}"?`);
    if (!confirmed) {
      setSquadMenuOpen(null);
      return;
    }

    const memberIdsToRemove = new Set(
      (squad.members || []).filter((memberId) => typeof memberId === "string" && memberId.trim().length > 0),
    );
    const updatedSquadAgents = squadAgents.filter((agent) => !memberIdsToRemove.has(agent.id || ""));
    saveSquadAgents(updatedSquadAgents);

    const updatedSquads = squads
      .filter((s) => s.id !== squad.id)
      .map((candidate) => ({
        ...candidate,
        members: (candidate.members || []).filter((memberId) => !memberIdsToRemove.has(memberId)),
      }));
    saveSquads(updatedSquads);

    const fallbackAgentId = resolveRequiredDefaultAgentId(agents);
    if (squad.id) {
      reassignConversations(squad.id, fallbackAgentId);
    }
    for (const memberId of memberIdsToRemove) {
      reassignConversations(memberId, fallbackAgentId);
    }

    const activeConversation = conversations.find((c) => c.id === activeConversationId);
    const removedSquadWasActiveConversationTarget = Boolean(activeConversation && activeConversation.agentId === squad.id);

    if (selectedSquadId === squad.id || removedSquadWasActiveConversationTarget) {
      setSelectedSquadId(null);
      setSelectedAgentId(fallbackAgentId);
      setIsMasterLogOpen(false);
    }

    setSquadMenuOpen(null);
  };

  const availableAgentsForSquadEditor = (() => {
    const editingSquadId = editingSquad?.id || null;
    const currentMemberIds = new Set((editingSquad?.members || []).filter((memberId) => typeof memberId === "string"));
    const assignedElsewhereIds = new Set(
      squads
        .filter((squad) => (editingSquadId ? squad.id !== editingSquadId : true))
        .flatMap((squad) => squad.members || []),
    );
    return squadAgents.filter((agent) => {
      const id = agent.id || "";
      if (!id) return false;
      if (currentMemberIds.has(id)) return true;
      return !assignedElsewhereIds.has(id);
    });
  })();

  const handleSwitchConversationAgent = (optionValue: string) => {
    if (optionValue === ACTIVE_SQUAD_OPTION_VALUE) {
      setChatSelectorMenuOpen(false);
      setChatSelectorSubmenu(null);
      return;
    }

    const defaultAgentId = resolveRequiredDefaultAgentId(agents);
    const targetAgentId = optionValue === DEFAULT_CHAT_AGENT_OPTION_VALUE
      ? defaultAgentId
      : optionValue;

    if (activeConversationId) {
      assignConversationToAgent(activeConversationId, targetAgentId);
    } else {
      setDraftAgentOverrides(null);
    }
    setSelectedAgentId(targetAgentId);
    setSelectedSquadId(null);
    setIsMasterLogOpen(false);
    setChatSelectorMenuOpen(false);
    setChatSelectorSubmenu(null);
  };

  const resolveCurrentChatOverrides = (): ConversationAgentOverrides => {
    if (activeConversationId) {
      const activeConversation = conversations.find((candidate) => candidate.id === activeConversationId);
      return activeConversation?.agentOverrides || {};
    }
    return draftAgentOverrides || {};
  };

  const persistChatOverrides = (overrides: ConversationAgentOverrides) => {
    const normalizedOverrides: ConversationAgentOverrides = {
      provider: overrides.provider?.trim().toLowerCase() || undefined,
      model: overrides.model?.trim() || undefined,
      reasoningEffort: overrides.reasoningEffort
        ? normalizeReasoningEffort(overrides.reasoningEffort)
        : undefined,
    };

    const hasOverrideValue = Boolean(
      normalizedOverrides.provider
      || normalizedOverrides.model
      || normalizedOverrides.reasoningEffort,
    );

    if (activeConversationId) {
      const allConversations = loadConversations();
      const updated = allConversations.map((conversation) => (
        conversation.id === activeConversationId
          ? { ...conversation, agentOverrides: hasOverrideValue ? normalizedOverrides : undefined, updatedAt: Date.now() }
          : conversation
      ));
      persistConversationList(updated);
      return;
    }

    setDraftAgentOverrides(hasOverrideValue ? normalizedOverrides : null);
  };

  const handleSelectModelForAgent = (agentId: string, providerId: string, modelId: string) => {
    const requiresToolUse = hasAnyToolCapability(modelSelectionAgent?.tools);
    if (requiresToolUse && !supportsToolUse(providerId, modelId)) {
      return;
    }
    const current = resolveCurrentChatOverrides();
    const supportsReasoning = supportsReasoningEffort(providerId, modelId);
    persistChatOverrides({
      ...current,
      provider: providerId,
      model: modelId,
      reasoningEffort: supportsReasoning
        ? current.reasoningEffort
        : "none",
    });
    setSelectedAgentId(agentId);
    setSelectedSquadId(null);
    setChatSelectorMenuOpen(false);
    setChatSelectorSubmenu(null);
  };

  const handleSelectReasoningForAgent = (agentId: string, reasoningEffort: ReasoningEffort) => {
    const current = resolveCurrentChatOverrides();
    const providerId = (current.provider || modelSelectionAgent?.provider || DEFAULT_PROVIDER_ID).toLowerCase();
    const modelId = current.model
      || modelSelectionAgent?.model
      || defaultRuntimeModelForProvider(providerId);
    if (!supportsReasoningEffort(providerId, modelId) && reasoningEffort !== "none") {
      return;
    }
    persistChatOverrides({
      ...current,
      reasoningEffort,
    });
    setSelectedAgentId(agentId);
    setSelectedSquadId(null);
    setChatSelectorMenuOpen(false);
    setChatSelectorSubmenu(null);
  };

  const handleCreateSquadAgents = async (prompt: string): Promise<{ createdAgents: AgentConfig[]; message: string }> => {
    const result = await executeCreateCatsCommand(prompt, undefined, undefined, undefined, "squad");
    return {
      createdAgents: result.createdAgents,
      message: result.content,
    };
  };

  const handleUpsertSquadAgent = (agent: AgentConfig) => {
    const id = agent.id || uuidv4();
    const normalizedAgent: AgentConfig = {
      ...agent,
      id,
      accessMode: normalizeAccessMode(agent.accessMode),
    };
    const exists = squadAgents.some((candidate) => candidate.id === id);
    saveSquadAgents(
      exists
        ? squadAgents.map((candidate) => candidate.id === id ? normalizedAgent : candidate)
        : [...squadAgents, normalizedAgent],
    );
  };

  const handleDeleteSquadAgent = (agentId: string) => {
    const updatedSquadAgents = squadAgents.filter((agent) => agent.id !== agentId);
    saveSquadAgents(updatedSquadAgents);

    const updatedSquads = squads
      .map((squad) => ({ ...squad, members: squad.members.filter((memberId) => memberId !== agentId) }))
      .filter((squad) => squad.members.length > 0);
    saveSquads(updatedSquads);

    if (selectedSquadId && !updatedSquads.some((s) => s.id === selectedSquadId)) {
      setSelectedSquadId(null);
      setActiveConversationId(null);
      setCurrentMessages([]);
      setCurrentSquadTrace([]);
      setIsMasterLogOpen(false);
    }
  };

  const createAgentAssistantMessage = (
    content: string,
    speaker: AgentConfig | undefined,
    fallbackName: string,
    options?: {
      suppressAutoPlay?: boolean;
    },
  ): Message => {
    const style = speaker?.style && VALID_AGENT_STYLES.has(speaker.style) ? speaker.style : "assistant";
    const isCharacter = style === "character";

    return {
      id: uuidv4(),
      role: "assistant",
      name: speaker?.name || fallbackName,
      content,
      timestamp: Date.now(),
      agentId: speaker?.id,
      agentStyle: style,
      voiceId: speaker?.voiceId || DEFAULT_VOICE_ID,
      typewriter: isCharacter,
      autoPlay: !options?.suppressAutoPlay && isCharacter,
    };
  };

  const createSystemMessage = (content: string): Message => ({
    id: uuidv4(),
    role: "system",
    content,
    timestamp: Date.now(),
  });

  const buildSquadStepMessages = (
    squad: SquadConfig,
    stepList: SquadRunStep[],
  ): Message[] => {
    const interactionConfig = getSquadInteractionConfig(squad);
    if (!interactionConfig.showAgentMessagesInChat || stepList.length === 0) {
      return [];
    }

    const participants = getSquadWorkerAgents(squad, squadAgents);
    const byId = new Map(participants.map((agent) => [agent.id || "", agent]));
    const orchestratorSpeaker = buildSquadOrchestratorAgent(squad);
    const output: Message[] = [];

    for (const step of stepList) {
      if (interactionConfig.includeDirectorMessagesInChat) {
        const summary = step.directorDecision.summary?.trim();
        if (summary) {
          const assignment = step.workerAgentName && step.workerInstruction
            ? `\n\nAssigned to ${step.workerAgentName}: ${step.workerInstruction}`
            : "";
          output.push(
            createAgentAssistantMessage(
              `${summary}${assignment}`,
              orchestratorSpeaker,
              orchestratorSpeaker.name || "OR",
              { suppressAutoPlay: true },
            ),
          );
        }
      }

      if (step.workerOutput?.trim()) {
        const worker = step.workerAgentId ? byId.get(step.workerAgentId) : undefined;
        output.push(
          createAgentAssistantMessage(
            step.workerOutput.trim(),
            worker,
            step.workerAgentName || "Worker",
          ),
        );
      }
    }

    return output;
  };

  interface RetryContext {
    retryUserMessage: Message;
    messagesWithoutError: Message[];
    historyBeforeRetryUser: Message[];
  }

  interface SendMessageOptions {
    regenerateErrorMessageId?: string;
  }

  const resolveRetryContext = (messageList: Message[], errorMessageId: string): RetryContext | null => {
    const errorIndex = messageList.findIndex((message) => message.id === errorMessageId);
    if (errorIndex <= 0) return null;

    const errorMessage = messageList[errorIndex];
    if (errorMessage.role !== "system" || !errorMessage.error) return null;

    const messagesBeforeError = messageList.slice(0, errorIndex);
    let retryUserIndex = -1;
    for (let index = messagesBeforeError.length - 1; index >= 0; index -= 1) {
      if (messagesBeforeError[index].role === "user") {
        retryUserIndex = index;
        break;
      }
    }

    if (retryUserIndex < 0) return null;

    return {
      retryUserMessage: messagesBeforeError[retryUserIndex],
      messagesWithoutError: messagesBeforeError,
      historyBeforeRetryUser: messagesBeforeError.slice(0, retryUserIndex),
    };
  };

  const handleSendMessage = async (text: string, options?: SendMessageOptions) => {
    if (!hasAnyApiKeyConfigured) return;
    if (isProcessing) return;

    const retryContext = options?.regenerateErrorMessageId
      ? resolveRetryContext(currentMessages, options.regenerateErrorMessageId)
      : null;
    if (options?.regenerateErrorMessageId && !retryContext) return;

    const messageText = retryContext ? retryContext.retryUserMessage.content : text;
    if (!messageText.trim()) return;

    const slashCommand = parseSlashCommand(messageText);
    const targetSquadRaw = selectedSquadId ? squads.find(s => s.id === selectedSquadId) : undefined;
    const targetSquad = targetSquadRaw ? normalizeSquadConfig(targetSquadRaw) : undefined;
    const isSquadMode = Boolean(targetSquad);
    const targetSquadInteractionConfig = targetSquad ? getSquadInteractionConfig(targetSquad) : undefined;
    if (isSquadMode && targetSquadInteractionConfig?.showMasterLog) {
      setIsMasterLogOpen(true);
    }

    const fallbackDefaultAgentId = resolveRequiredDefaultAgentId(agents);
    const targetAgent = agents.find((agent) => agent.id === selectedAgentId);
    const baseAgent = targetAgent
      || agents.find((agent) => agent.id === fallbackDefaultAgentId)
      || TEMPLATE_DEFAULT_AGENT;

    const activeConversationOverrides = activeConversationId
      ? conversations.find((conversation) => conversation.id === activeConversationId)?.agentOverrides
      : undefined;
    const effectiveAgentOverrides = !isSquadMode
      ? (activeConversationOverrides || draftAgentOverrides || undefined)
      : undefined;

    const effectiveAgent = !baseAgent || isSquadMode
      ? baseAgent
      : {
        ...baseAgent,
        provider: effectiveAgentOverrides?.provider || baseAgent.provider,
        model: effectiveAgentOverrides?.model || baseAgent.model,
        reasoningEffort: effectiveAgentOverrides?.reasoningEffort || baseAgent.reasoningEffort,
      };

    if (!effectiveAgent && !targetSquad) return;

    const selectedParticipantId = selectedSquadId || effectiveAgent?.id || fallbackDefaultAgentId;
    if (!selectedParticipantId) return;
    if (!selectedSquadId && selectedAgentId !== selectedParticipantId) {
      setSelectedAgentId(selectedParticipantId);
    }

    // Create or use existing conversation
    let convId = activeConversationId;
    let isNew = false;

    if (!convId) {
      // Create new conversation
      convId = uuidv4();
      isNew = true;
    }

    const newUserMsg: Message = retryContext?.retryUserMessage || {
      id: uuidv4(),
      role: "user",
      content: messageText,
      timestamp: Date.now(),
    };
    const requestHistory = retryContext ? retryContext.historyBeforeRetryUser : currentMessages;
    const updatedMessages = retryContext
      ? retryContext.messagesWithoutError
      : [...currentMessages, newUserMsg];
    const existingTrace = currentSquadTrace;
    setCurrentMessages(updatedMessages);
    setActiveConversationId(convId);

    // Save conversation immediately (so it appears in history)
    const conv: Conversation = {
      id: convId,
      agentId: selectedParticipantId,
      title: isNew ? generateTitle(messageText) : (conversations.find(c => c.id === convId)?.title || generateTitle(messageText)),
      messages: updatedMessages,
      squadTrace: existingTrace,
      agentOverrides: isSquadMode ? undefined : effectiveAgentOverrides,
      createdAt: isNew ? Date.now() : (conversations.find(c => c.id === convId)?.createdAt || Date.now()),
      updatedAt: Date.now(),
    };
    upsertConversation(conv);
    refreshConversations();
    let latestMessagesState = updatedMessages;
    let latestTraceState = existingTrace;

    setIsProcessing(true);

    try {
      if (slashCommand) {
        const commandResult = await executeSlashCommand(slashCommand, effectiveAgent, targetSquad);
        const commandReply: Message = {
          id: uuidv4(),
          role: commandResult.role,
          name: commandResult.role === "assistant"
            ? (effectiveAgent?.name || targetSquad?.name || "System")
            : undefined,
          content: commandResult.content,
          timestamp: Date.now(),
        };

        const finalMessages = [...updatedMessages, commandReply];
        setCurrentMessages(finalMessages);
        setCurrentSquadTrace(existingTrace);
        latestMessagesState = finalMessages;
        latestTraceState = existingTrace;

        upsertConversation({
          ...conv,
          messages: finalMessages,
          squadTrace: existingTrace,
          updatedAt: Date.now(),
        });
        refreshConversations();
        return;
      }

      const effectiveAccessMode: AccessPermissionMode = isSquadMode
        ? normalizeAccessMode(targetSquad?.accessMode)
        : normalizeAccessMode(effectiveAgent?.accessMode);
      const hasPrivilegedToolsInScope = isSquadMode && targetSquad
        ? getSquadWorkerAgents(targetSquad, squadAgents)
          .some((agent) => hasPrivilegedToolCapability(agent.tools))
        : hasPrivilegedToolCapability(effectiveAgent?.tools);
      let toolAccessGranted = effectiveAccessMode === "full_access";
      if (effectiveAccessMode === "ask_always" && hasPrivilegedToolsInScope) {
        toolAccessGranted = window.confirm(
          "This run may use file writes or shell commands. Allow privileged tool access for this turn?\n\nOK = allow once\nCancel = continue in read-only mode",
        );
      }

      debugClientLog("page", "Requesting /api/chat", {
        isSquadMode,
        historyCount: requestHistory.length,
        messageLength: messageText.length,
        accessMode: effectiveAccessMode,
        privilegedToolsInScope: hasPrivilegedToolsInScope,
        toolAccessGranted,
      });
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-groq-api-key": apiKey || "",
          "x-api-keys": JSON.stringify(apiKeys),
          ...(isSquadMode ? { "x-squad-stream": "1" } : {}),
          ...(debugLogsEnabled ? { "x-debug-logs": "1" } : {}),
        },
        body: JSON.stringify({
          message: messageText,
          history: requestHistory,
          toolAccessGranted,
          ...(isSquadMode
            ? { squadConfig: targetSquad, agents: squadAgents }
            : { agentConfig: effectiveAgent, agents })
        })
      });
      debugClientLog("page", "Received /api/chat response", { ok: response.ok, status: response.status, isSquadMode });
      const contentType = response.headers.get("content-type") || "";

      if (isSquadMode && contentType.includes("application/x-ndjson") && response.body) {
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(errText || `Request failed (${response.status})`);
        }

        const traceTurnId = uuidv4();
        const traceTimestamp = Date.now();
        const streamedSteps: SquadRunStep[] = [];
        const streamedStepMessages: Message[] = [];
        let streamedResponseText = "";
        let streamedStatus: unknown = "completed";
        let receivedCompletion = false;
        const interactionConfig = targetSquadInteractionConfig;

        const publishLiveState = (status: SquadTraceTurn["status"]) => {
          const liveTraceTurn: SquadTraceTurn = {
            id: traceTurnId,
            timestamp: traceTimestamp,
            userMessage: messageText,
            status,
            steps: [...streamedSteps],
          };
          const nextTrace = [...existingTrace, liveTraceTurn];
          const nextMessages = [...updatedMessages, ...streamedStepMessages];
          latestTraceState = nextTrace;
          latestMessagesState = nextMessages;
          setCurrentSquadTrace(nextTrace);
          setCurrentMessages(nextMessages);
          upsertConversation({
            ...conv,
            messages: nextMessages,
            squadTrace: nextTrace,
            updatedAt: Date.now(),
          });
          refreshConversations();
        };

        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const rawLine = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (rawLine.length > 0) {
              const event = JSON.parse(rawLine) as {
                type?: string;
                step?: SquadRunStep;
                response?: string;
                squadStatus?: unknown;
                squadSteps?: SquadRunStep[];
                error?: string;
              };

              if (event.type === "squad_step" && event.step) {
                streamedSteps.push(event.step);
                if (targetSquad) {
                  streamedStepMessages.push(...buildSquadStepMessages(targetSquad, [event.step]));
                }
                let liveStatus: SquadTraceTurn["status"] = "in_progress";
                const directorStatus = event.step.directorDecision?.status;
                if (directorStatus === "needs_user_input") liveStatus = "needs_user_input";
                if (directorStatus === "blocked") liveStatus = "blocked";
                publishLiveState(liveStatus);
              } else if (event.type === "squad_complete") {
                if (Array.isArray(event.squadSteps) && event.squadSteps.length > 0) {
                  streamedSteps.splice(0, streamedSteps.length, ...event.squadSteps);
                }
                streamedResponseText = typeof event.response === "string" ? event.response : "";
                streamedStatus = event.squadStatus;
                receivedCompletion = true;
              } else if (event.type === "error") {
                throw new Error(event.error || "Squad stream error");
              }
            }

            newlineIndex = buffer.indexOf("\n");
          }
        }

        const trailing = buffer.trim();
        if (trailing.length > 0) {
          const event = JSON.parse(trailing) as {
            type?: string;
            response?: string;
            squadStatus?: unknown;
            squadSteps?: SquadRunStep[];
            error?: string;
          };
          if (event.type === "squad_complete") {
            if (Array.isArray(event.squadSteps) && event.squadSteps.length > 0) {
              streamedSteps.splice(0, streamedSteps.length, ...event.squadSteps);
            }
            streamedResponseText = typeof event.response === "string" ? event.response : "";
            streamedStatus = event.squadStatus;
            receivedCompletion = true;
          } else if (event.type === "error") {
            throw new Error(event.error || "Squad stream error");
          }
        }

        if (!receivedCompletion) {
          throw new Error("Squad stream ended before completion.");
        }

        const finalResponseMessages: Message[] = [...streamedStepMessages];
        if (targetSquad) {
          const includeDirectorMessages = Boolean(interactionConfig?.includeDirectorMessagesInChat);
          const orchestratorSpeaker = buildSquadOrchestratorAgent(targetSquad);
          const lastVisibleMessage = finalResponseMessages[finalResponseMessages.length - 1];
          const shouldAppendFinal = streamedResponseText.trim().length > 0
            && (!lastVisibleMessage || lastVisibleMessage.content.trim() !== streamedResponseText.trim());

          if (includeDirectorMessages && (shouldAppendFinal || finalResponseMessages.length === 0)) {
            finalResponseMessages.push(
              createAgentAssistantMessage(
                streamedResponseText || "The squad completed this turn.",
                orchestratorSpeaker,
                orchestratorSpeaker.name || targetSquad.name,
                { suppressAutoPlay: true },
              ),
            );
          } else if (!includeDirectorMessages && finalResponseMessages.length === 0 && streamedResponseText.trim().length > 0) {
            finalResponseMessages.push(createSystemMessage(streamedResponseText));
          }
        }

        const finalMessages = [...updatedMessages, ...finalResponseMessages];
        const finalTraceTurn: SquadTraceTurn = {
          id: traceTurnId,
          timestamp: traceTimestamp,
          userMessage: messageText,
          status: normalizeTraceStatus(streamedStatus),
          steps: [...streamedSteps],
        };
        const finalTrace = [...existingTrace, finalTraceTurn];

        latestMessagesState = finalMessages;
        latestTraceState = finalTrace;
        setCurrentMessages(finalMessages);
        setCurrentSquadTrace(finalTrace);

        upsertConversation({
          ...conv,
          messages: finalMessages,
          squadTrace: finalTrace,
          updatedAt: Date.now(),
        });
        refreshConversations();
        return;
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      const responseText = typeof data.response === "string" ? data.response : "";
      const squadSteps = Array.isArray(data.squadSteps) ? (data.squadSteps as SquadRunStep[]) : [];
      const interactionConfig = targetSquadInteractionConfig;
      const visibleStepMessages = targetSquad ? buildSquadStepMessages(targetSquad, squadSteps) : [];

      const finalResponseMessages: Message[] = [];
      if (isSquadMode && targetSquad) {
        finalResponseMessages.push(...visibleStepMessages);
      }

      if (!isSquadMode) {
        finalResponseMessages.push(
          createAgentAssistantMessage(responseText, effectiveAgent, effectiveAgent?.name || "Assistant"),
        );
      } else if (targetSquad) {
        const includeDirectorMessages = Boolean(interactionConfig?.includeDirectorMessagesInChat);
        const orchestratorSpeaker = buildSquadOrchestratorAgent(targetSquad);
        const lastVisibleMessage = finalResponseMessages[finalResponseMessages.length - 1];
        const shouldAppendFinal = responseText.trim().length > 0
          && (!lastVisibleMessage || lastVisibleMessage.content.trim() !== responseText.trim());

        if (includeDirectorMessages && (shouldAppendFinal || finalResponseMessages.length === 0)) {
          finalResponseMessages.push(
            createAgentAssistantMessage(
              responseText || "The squad completed this turn.",
              orchestratorSpeaker,
              orchestratorSpeaker.name || targetSquad.name,
              { suppressAutoPlay: true },
            ),
          );
        } else if (!includeDirectorMessages && finalResponseMessages.length === 0 && responseText.trim().length > 0) {
          finalResponseMessages.push(createSystemMessage(responseText));
        }
      }

      const finalMessages = [...updatedMessages, ...finalResponseMessages];
      latestMessagesState = finalMessages;
      setCurrentMessages(finalMessages);
      let finalTrace = existingTrace;
      if (isSquadMode && squadSteps.length > 0) {
        const normalizedStatus = normalizeTraceStatus(data.squadStatus);
        const traceTurn: SquadTraceTurn = {
          id: uuidv4(),
          timestamp: Date.now(),
          userMessage: messageText,
          status: normalizedStatus,
          steps: squadSteps,
        };
        finalTrace = [...existingTrace, traceTurn];
      }
      latestTraceState = finalTrace;
      setCurrentSquadTrace(finalTrace);

      // Update conversation in storage
      upsertConversation({
        ...conv,
        messages: finalMessages,
        squadTrace: finalTrace,
        updatedAt: Date.now(),
      });
      refreshConversations();

    } catch (e: unknown) {
      debugClientError("page", e, "Chat request failed");
      console.error("Chat Failed", e);
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      const errorMsg: Message = {
        id: uuidv4(),
        role: "system",
        content: `Hiss! Something went wrong. ${errorMessage}`,
        error: true,
        timestamp: Date.now()
      };
      const finalMessages = [...latestMessagesState, errorMsg];
      setCurrentMessages(finalMessages);
      latestMessagesState = finalMessages;
      setCurrentSquadTrace(latestTraceState);

      upsertConversation({
        ...conv,
        messages: finalMessages,
        squadTrace: latestTraceState,
        updatedAt: Date.now(),
      });
      refreshConversations();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRegenerateFromError = async (errorMessageId: string) => {
    await handleSendMessage("", { regenerateErrorMessageId: errorMessageId });
  };

  // Group conversations by time period
  const groupConversations = (convos: Conversation[]) => {
    const now = Date.now();
    const day = 86400000;
    const groups: { label: string; items: Conversation[] }[] = [];

    const today: Conversation[] = [];
    const yesterday: Conversation[] = [];
    const thisWeek: Conversation[] = [];
    const older: Conversation[] = [];

    for (const c of convos) {
      const age = now - c.updatedAt;
      if (age < day) today.push(c);
      else if (age < day * 2) yesterday.push(c);
      else if (age < day * 7) thisWeek.push(c);
      else older.push(c);
    }

    if (today.length > 0) groups.push({ label: "Today", items: today });
    if (yesterday.length > 0) groups.push({ label: "Yesterday", items: yesterday });
    if (thisWeek.length > 0) groups.push({ label: "This Week", items: thisWeek });
    if (older.length > 0) groups.push({ label: "Older", items: older });

    return groups;
  };

  const conversationGroups = groupConversations(conversations);
  const defaultAgentId = resolveRequiredDefaultAgentId(agents);
  const defaultAgent = defaultAgentId ? agents.find((agent) => agent.id === defaultAgentId) : undefined;
  const activeConversation = activeConversationId
    ? conversations.find((conversation) => conversation.id === activeConversationId)
    : undefined;
  const activeConversationAgent = activeConversation
    ? agents.find((agent) => agent.id === activeConversation.agentId)
    : undefined;
  const activeConversationSquad = activeConversation
    ? squads.find((squad) => squad.id === activeConversation.agentId)
    : undefined;
  const activeConversationAgentSelectorValue = activeConversationAgent?.id
    || (activeConversationSquad ? ACTIVE_SQUAD_OPTION_VALUE : (
      selectedAgentId === defaultAgentId ? DEFAULT_CHAT_AGENT_OPTION_VALUE : selectedAgentId
    ));
  const selectedSquadRaw = selectedSquadId ? squads.find((s) => s.id === selectedSquadId) : undefined;
  const selectedSquad = selectedSquadRaw ? normalizeSquadConfig(selectedSquadRaw) : undefined;
  const selectedSquadInteraction = selectedSquad ? getSquadInteractionConfig(selectedSquad) : undefined;
  const squadParticipants = selectedSquad
    ? getSquadWorkerAgents(selectedSquad, squadAgents)
    : [];
  const selectedSquadChatAgent: AgentConfig | null = selectedSquad
    ? {
      ...buildSquadOrchestratorAgent(selectedSquad),
      id: selectedSquad.id,
      name: selectedSquad.name,
      systemPrompt: getSquadGoal(selectedSquad) || "Coordinate worker agents to complete tasks.",
    }
    : null;
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const activeChatAgent = selectedSquadChatAgent || selectedAgent || defaultAgent || TEMPLATE_DEFAULT_AGENT || null;
  const activeChatOverrides = activeConversation?.agentOverrides
    || (!selectedSquad ? draftAgentOverrides || undefined : undefined);
  const effectiveActiveChatAgent: AgentConfig | null = activeChatAgent && !selectedSquad
    ? {
      ...activeChatAgent,
      provider: activeChatOverrides?.provider || activeChatAgent.provider,
      model: activeChatOverrides?.model || activeChatAgent.model,
      reasoningEffort: activeChatOverrides?.reasoningEffort || activeChatAgent.reasoningEffort,
    }
    : activeChatAgent;
  const isDefaultAgentChat = Boolean(
    !selectedSquad
    && effectiveActiveChatAgent
    && (
      (defaultAgentId && effectiveActiveChatAgent.id === defaultAgentId)
      || (!defaultAgentId && TEMPLATE_DEFAULT_AGENT?.id && effectiveActiveChatAgent.id === TEMPLATE_DEFAULT_AGENT.id)
    ),
  );
  const userAgents = agents.filter((agent) => agent.id !== SYSTEM_DEFAULT_AGENT_ID);
  const openAgentMenuAgent = agentMenuOpen
    ? userAgents.find((agent) => agent.id === agentMenuOpen) || null
    : null;
  const openSquadMenuSquad = squadMenuOpen
    ? squads.find((squad) => squad.id === squadMenuOpen) || null
    : null;
  const providerById = new Map(llmProviders.map((provider) => [provider.id, provider]));
  const runtimeActiveChatAgent: AgentConfig | null = (() => {
    if (!effectiveActiveChatAgent) return null;

    const providerId = (effectiveActiveChatAgent.provider || DEFAULT_PROVIDER_ID).trim().toLowerCase();
    const requireToolUse = hasAnyToolCapability(effectiveActiveChatAgent.tools);
    const fallbackModel = defaultRuntimeModelForProvider(providerId, { requireToolUse });
    const modelCandidate = String(effectiveActiveChatAgent.model || "").trim();
    const modelId = modelCandidate
      && isModelChatCapable({ id: modelCandidate }, providerId)
      && (!requireToolUse || supportsToolUse(providerId, modelCandidate))
      ? modelCandidate
      : fallbackModel;
    const requestedReasoning = normalizeReasoningEffort(
      effectiveActiveChatAgent.reasoningEffort || DEFAULT_REASONING_EFFORT,
    );
    const reasoningEffort = supportsReasoningEffort(providerId, modelId)
      ? requestedReasoning
      : "none";

    return {
      ...effectiveActiveChatAgent,
      provider: providerId,
      model: modelId,
      reasoningEffort,
    };
  })();
  const modelSelectionAgent = activeConversationAgent
    || ((activeConversationSquad || selectedSquad) ? null : (selectedAgent || defaultAgent || null));
  const modelSelectionRequiresToolUse = hasAnyToolCapability(modelSelectionAgent?.tools);
  const modelSelectionProviders = llmProviders
    .filter((provider) => hasProviderKeyConfigured(provider.id))
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => {
        const isChatModel = isModelChatCapable(model, provider.id);
        if (!isChatModel) return false;
        if (!modelSelectionRequiresToolUse) return true;
        return model.capabilities?.nativeTools ?? supportsToolUse(provider.id, model.id);
      }),
    }))
    .filter((provider) => provider.models.length > 0);
  const displayedProviderId = (runtimeActiveChatAgent?.provider || DEFAULT_PROVIDER_ID).toLowerCase();
  const displayedProvider = providerById.get(displayedProviderId);
  const displayedModelId = runtimeActiveChatAgent?.model || displayedProvider?.defaultModel || DEFAULT_MODEL_ID;
  const displayedModelLabel = displayedProvider?.models.find((model) => model.id === displayedModelId)?.label || displayedModelId;
  const selectedModelProviderId = (activeChatOverrides?.provider || modelSelectionAgent?.provider || DEFAULT_PROVIDER_ID).toLowerCase();
  const selectedModelProvider = modelSelectionProviders.find((provider) => provider.id === selectedModelProviderId)
    || modelSelectionProviders[0];
  const selectedModelId = activeChatOverrides?.model
    || modelSelectionAgent?.model
    || selectedModelProvider?.models[0]?.id
    || selectedModelProvider?.defaultModel
    || DEFAULT_MODEL_ID;
  const selectedModel = selectedModelProvider?.models.find((model) => model.id === selectedModelId);
  const selectedModelSupportsReasoning = selectedModel
    ? (selectedModel.capabilities?.reasoning ?? supportsReasoningEffort(selectedModelProvider?.id || DEFAULT_PROVIDER_ID, selectedModel.id))
    : false;
  const selectedReasoningEffort = normalizeReasoningEffort(
    activeChatOverrides?.reasoningEffort
    || modelSelectionAgent?.reasoningEffort
    || DEFAULT_REASONING_EFFORT,
  );
  const effectiveSelectedReasoningEffort = selectedModelSupportsReasoning
    ? selectedReasoningEffort
    : "none";
  const canSelectModel = Boolean(modelSelectionAgent?.id) && modelSelectionProviders.length > 0;
  const canSelectReasoning = Boolean(modelSelectionAgent?.id) && selectedModelSupportsReasoning;
  const chatCatOptions = [
    ...(activeConversationSquad ? [{
      value: ACTIVE_SQUAD_OPTION_VALUE,
      label: `Squad: ${activeConversationSquad.name}`,
      disabled: false,
    }] : []),
    {
      value: DEFAULT_CHAT_AGENT_OPTION_VALUE,
      label: `Default${defaultAgent ? ` (${defaultAgent.name})` : ""}`,
      disabled: !defaultAgentId,
    },
    ...userAgents
      .filter((agent) => Boolean(agent.id))
      .map((agent) => ({
        value: agent.id || "",
        label: agent.name,
        disabled: false,
      })),
  ];
  const activeChatCatLabel = chatCatOptions.find((option) => option.value === activeConversationAgentSelectorValue)?.label || "Select cat";
  const showChatAgentSelector = Boolean(activeConversation || (!selectedSquad && runtimeActiveChatAgent));
  const shouldShowMasterLog = Boolean(selectedSquad && selectedSquadInteraction?.showMasterLog);
  const latestTraceTurn = currentSquadTrace.length > 0
    ? currentSquadTrace[currentSquadTrace.length - 1]
    : null;
  const isLiveRunActive = Boolean(isProcessing && latestTraceTurn && latestTraceTurn.status === "in_progress");
  const liveStepCount = latestTraceTurn?.steps.length || 0;
  const liveElapsed = latestTraceTurn ? formatElapsed(masterLogNow - latestTraceTurn.timestamp) : "0s";

  const getTraceStatusColor = (status: SquadTraceTurn["status"]) => {
    if (status === "in_progress") return "text-[#7aa2f7] bg-[#7aa2f7]/10 border-[#7aa2f7]/20";
    if (status === "completed") return "text-[#9ece6a] bg-[#9ece6a]/10 border-[#9ece6a]/20";
    if (status === "needs_user_input") return "text-[#e0af68] bg-[#e0af68]/10 border-[#e0af68]/20";
    if (status === "blocked") return "text-[#f7768e] bg-[#f7768e]/10 border-[#f7768e]/20";
    return "text-[#7aa2f7] bg-[#7aa2f7]/10 border-[#7aa2f7]/20";
  };

  const handleSidebarResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!sidebarOpen) return;
    event.preventDefault();
    sidebarResizeStartXRef.current = event.clientX;
    sidebarResizeStartWidthRef.current = sidebarWidth;
    setIsResizingSidebar(true);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#212121] text-[#ececec] font-sans">

      {/* Sidebar - Collapsible */}
      <div
        className={`${sidebarOpen ? "shrink-0" : "w-0"} bg-[#171717] flex flex-col overflow-hidden border-r border-white/5 md:border-r-0 relative z-30 ${sidebarOpen && !isResizingSidebar ? "transition-[width] duration-300 ease-in-out" : ""}`}
        style={sidebarOpen ? { width: `${sidebarWidth}px` } : undefined}
      >
        {/* New Chat Button Area */}
        <div className="p-3 pb-0">
          <button
            onClick={handleNewChat}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border border-white/10 text-sm hover:bg-[#212121] transition-colors text-white text-left shadow-sm group"
          >
            <div className="bg-white text-black rounded-full p-0.5">
              <Plus size={14} strokeWidth={3} />
            </div>
            <span className="font-medium">New chat</span>
            <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
              <MessageSquare size={14} />
            </span>
          </button>
        </div>

        {/* Navigation / Sections */}
        <div className="px-3 py-4 flex flex-col gap-1 flex-1 min-h-0 overflow-hidden">

          {/* Agents Section Header */}
          <div className="text-xs font-semibold text-[#8e8ea0] px-3 py-2 uppercase tracking-wider flex items-center justify-between flex-shrink-0">
            <span className="flex items-center gap-2">
              <PawPrint size={12} className="text-[#10a37f]" />
              Litter
            </span>
            <span className="text-[10px] font-normal text-[#565656]">{userAgents.length} cats</span>
          </div>

          {/* Agents List */}
          <div className="space-y-1 pr-1 flex-shrink-0 max-h-[40%] overflow-y-auto custom-scrollbar">
            {userAgents.map(agent => {
              const isSelected = !selectedSquadId && selectedAgentId === agent.id;
              const personality = getAgentPersonality(agent);
              const providerId = (agent.provider || DEFAULT_PROVIDER_ID).trim().toLowerCase();
              const modelId = (agent.model || defaultModelForProvider(providerId)).trim();
              const toolsEnabled = Array.isArray(agent.tools) && agent.tools.length > 0;
              const reasoningEnabled = supportsReasoningEffort(providerId, modelId)
                && normalizeReasoningEffort(agent.reasoningEffort) !== "none";

              return (
                <div
                  key={agent.id}
                  className="relative"
                  ref={(node) => {
                    const id = agent.id || "";
                    if (!id) return;
                    if (node) {
                      agentCardRefs.current[id] = node;
                    } else {
                      delete agentCardRefs.current[id];
                    }
                  }}
                >
                  <button
                    onClick={() => handleSelectAgent(agent.id || "")}
                    className={`agent-card w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm group relative overflow-hidden ${isSelected
                      ? "active bg-[#2f2f2f] text-white"
                      : "text-[#ececec] hover:bg-[#212121]"
                      }`}
                    style={{ '--agent-accent': personality.color } as React.CSSProperties}
                  >
                    {/* Cat Avatar */}
                    <div
                      className={`agent-avatar w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-lg relative`}
                      style={{ background: personality.gradient }}
                    >
                      <span className="cat-emoji" role="img" aria-label={personality.label}>
                        {personality.emoji}
                      </span>
                      {/* Online status dot */}
                      {isSelected && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-[#171717] rounded-full flex items-center justify-center">
                          <div className="w-2 h-2 rounded-full bg-[#10a37f] status-dot-purr" />
                        </div>
                      )}
                    </div>

                    {/* Name & Role */}
                    <div className="flex-1 min-w-0 text-left">
                      <div className={`text-[13px] font-medium leading-tight ${isSelected ? "text-white" : "text-[#ececec]"}`}>
                        {agent.name}
                      </div>
                      <div className="text-[11px] text-[#8e8ea0] leading-tight mt-0.5">
                        {agent.role}
                      </div>
                    </div>

                    {/* Capability icons */}
                    {(toolsEnabled || reasoningEnabled) && (
                      <div className="flex items-center gap-1.5 text-[#8e8ea0]">
                        {toolsEnabled && (
                          <span
                            className="inline-flex items-center justify-center"
                            title="Tools enabled"
                            aria-label="Tools enabled"
                          >
                            <Wrench size={12} />
                          </span>
                        )}
                        {reasoningEnabled && (
                          <span
                            className="inline-flex items-center justify-center"
                            title="Reasoning enabled"
                            aria-label="Reasoning enabled"
                          >
                            <Brain size={12} />
                          </span>
                        )}
                      </div>
                    )}

                    {/* Three-dot menu button */}
                    <div
                      className={`flex-shrink-0 transition-opacity ${isSelected || agentMenuOpen === agent.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        }`}
                    >
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          setSquadMenuOpen(null);
                          const nextMenuId = agentMenuOpen === agent.id ? null : (agent.id || null);
                          setAgentMenuOpen(nextMenuId);
                          if (nextMenuId) {
                            window.requestAnimationFrame(() => updateAgentMenuPosition(nextMenuId));
                          }
                        }}
                        className="p-1 rounded hover:bg-[#424242] transition-colors cursor-pointer"
                      >
                        <MoreHorizontal size={14} className="text-[#8e8ea0]" />
                      </div>
                    </div>
                  </button>

                </div>
              );
            })}

            <button
              onClick={() => { setEditingAgent(undefined); setIsHiringOpen(true); }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-[#8e8ea0] hover:text-[#10a37f] hover:bg-[#10a37f]/5 transition-all mt-2 border border-dashed border-white/10 hover:border-[#10a37f]/30 group"
            >
              <div className="w-8 h-8 rounded-full border-2 border-dashed border-[#424242] group-hover:border-[#10a37f]/50 flex items-center justify-center transition-colors">
                <Plus size={14} />
              </div>
              <span>Hire New Agent</span>
            </button>
          </div>

          {/* Squads Section */}
          <div className="text-xs font-semibold text-[#8e8ea0] px-3 py-2 mt-3 uppercase tracking-wider flex items-center justify-between flex-shrink-0">
            <span className="flex items-center gap-2">
              <Users size={12} className="text-[#10a37f]" />
              Squads
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsBlueprintLibraryOpen(true)}
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#8e8ea0] hover:text-[#ececec] transition-colors"
                title="Open Squad Blueprints"
              >
                <BookTemplate size={11} />
                Blueprints
              </button>
              <span className="text-[10px] font-normal text-[#565656]">{squads.length}</span>
            </div>
          </div>

          <div className="space-y-1 pr-1 flex-shrink-0 max-h-[24%] overflow-y-auto custom-scrollbar">
            {squads.map((squad) => {
              const isSelected = selectedSquadId === squad.id;
              const memberCount = getSquadWorkerAgents(normalizeSquadConfig(squad), squadAgents).length;

              return (
                <div
                  key={squad.id}
                  className="relative group"
                  ref={(node) => {
                    const id = squad.id || "";
                    if (!id) return;
                    if (node) {
                      squadCardRefs.current[id] = node;
                    } else {
                      delete squadCardRefs.current[id];
                    }
                  }}
                >
                  <button
                    onClick={() => handleSelectSquad(squad.id || "")}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${isSelected
                      ? "bg-[#2f2f2f] text-white"
                      : "text-[#ececec] hover:bg-[#212121]"
                      }`}
                  >
                    <div className="w-8 h-8 rounded-full bg-[#2f2f2f] border border-[#424242] flex items-center justify-center text-[#10a37f]">
                      <Users size={14} />
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <div className="text-[13px] font-medium leading-tight truncate">{squad.name}</div>
                      <div className="text-[11px] text-[#8e8ea0] truncate">
                        {memberCount} worker{memberCount === 1 ? "" : "s"}
                      </div>
                    </div>

                    <div
                      className={`flex-shrink-0 transition-opacity ${isSelected || squadMenuOpen === squad.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                        }`}
                    >
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          setAgentMenuOpen(null);
                          const nextMenuId = squadMenuOpen === squad.id ? null : (squad.id || null);
                          setSquadMenuOpen(nextMenuId);
                          if (nextMenuId) {
                            window.requestAnimationFrame(() => updateSquadMenuPosition(nextMenuId));
                          }
                        }}
                        className="p-1 rounded hover:bg-[#424242] transition-colors cursor-pointer"
                      >
                        <MoreHorizontal size={14} className="text-[#8e8ea0]" />
                      </div>
                    </div>
                  </button>

                </div>
              );
            })}

            <button
              onClick={() => {
                setEditingSquad(undefined);
                setIsSquadEditorOpen(true);
              }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-[#8e8ea0] hover:text-[#10a37f] hover:bg-[#10a37f]/5 transition-all mt-2 border border-dashed border-white/10 hover:border-[#10a37f]/30 group"
            >
              <div className="w-8 h-8 rounded-full border-2 border-dashed border-[#424242] group-hover:border-[#10a37f]/50 flex items-center justify-center transition-colors">
                <Plus size={14} />
              </div>
              <span>Create Squad</span>
            </button>

            <button
              onClick={() => setIsBlueprintLibraryOpen(true)}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-[#8e8ea0] hover:text-[#10a37f] hover:bg-[#10a37f]/5 transition-all border border-dashed border-white/10 hover:border-[#10a37f]/30 group"
            >
              <div className="w-8 h-8 rounded-full border-2 border-dashed border-[#424242] group-hover:border-[#10a37f]/50 flex items-center justify-center transition-colors">
                <BookTemplate size={14} />
              </div>
              <span>Import Squad Blueprint</span>
            </button>
          </div>

          {/* Chat History Section — Always visible */}
          <div className="text-xs font-semibold text-[#8e8ea0] px-3 py-2 mt-3 uppercase tracking-wider flex items-center gap-2 flex-shrink-0">
            <Clock size={12} className="text-[#565656]" />
            Chat History
          </div>

          <div className="flex-1 overflow-y-auto space-y-0.5 pr-1 custom-scrollbar min-h-0">
            {conversationGroups.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-[#565656]">
                No conversations yet.<br />
                Select an agent or squad and start chatting! 🐾
              </div>
            )}

            {conversationGroups.map(group => (
              <div key={group.label}>
                <div className="text-[10px] font-medium text-[#565656] px-3 py-1.5 uppercase tracking-wider">
                  {group.label}
                </div>
                {group.items.map(conv => {
                  const convAgent = agents.find(a => a.id === conv.agentId);
                  const convSquad = squads.find(s => s.id === conv.agentId);
                  const convPersonality = convAgent ? getAgentPersonality(convAgent) : null;
                  const convLabel = convAgent?.name || convSquad?.name || "Unknown";

                  return (
                    <div key={conv.id} className="relative group">
                      {renamingChatId === conv.id ? (
                        <div className="px-3 py-1.5">
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={() => handleRenameConversation(conv.id, renameValue)}
                            onKeyDown={e => {
                              if (e.key === "Enter") handleRenameConversation(conv.id, renameValue);
                              if (e.key === "Escape") setRenamingChatId(null);
                            }}
                            className="w-full bg-[#2f2f2f] border border-white/20 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:border-[#10a37f]"
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => handleSelectConversation(conv.id)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-xs transition-colors ${activeConversationId === conv.id
                            ? "bg-[#2f2f2f] text-white"
                            : "text-[#b4b4b4] hover:bg-[#212121] hover:text-[#ececec]"
                            }`}
                        >
                          {/* Agent emoji indicator */}
                          <span className="flex-shrink-0 text-sm" title={convLabel}>
                            {convPersonality?.emoji || (convSquad ? "👥" : "💬")}
                          </span>
                          <span className="flex-1 truncate">{conv.title}</span>

                          {/* Chat menu button */}
                          <div
                            className={`flex-shrink-0 transition-opacity ${activeConversationId === conv.id || chatMenuOpen === conv.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSquadMenuOpen(null);
                              setChatMenuOpen(chatMenuOpen === conv.id ? null : conv.id);
                            }}
                          >
                            <MoreHorizontal size={12} className="text-[#8e8ea0] hover:text-white" />
                          </div>
                        </button>
                      )}

                      {/* Chat Dropdown Menu */}
                      {chatMenuOpen === conv.id && (
                        <div className="absolute right-2 top-full mt-0.5 bg-[#2f2f2f] border border-white/10 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-1 duration-150 min-w-[140px]">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameValue(conv.title);
                              setRenamingChatId(conv.id);
                              setChatMenuOpen(null);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#ececec] hover:bg-[#424242] transition-colors"
                          >
                            <Pencil size={11} />
                            <span>Rename</span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteConversation(conv.id);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 size={11} />
                            <span>Delete</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* User Profile at Bottom */}
        <div className="mt-auto p-3 border-t border-white/5">
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="flex items-center gap-3 w-full px-3 py-3 rounded-lg hover:bg-[#212121] transition-colors text-sm text-left group"
          >
            <div className="flex-1 truncate font-medium text-[#ececec]">API Settings</div>
            <Settings size={16} className="text-[#8e8ea0] group-hover:text-white transition-colors" />
          </button>
        </div>
      </div>

      {sidebarOpen && (
        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          onMouseDown={handleSidebarResizeStart}
          className="hidden md:flex w-2 shrink-0 items-stretch justify-center cursor-col-resize bg-transparent hover:bg-white/5 transition-colors"
        >
          <div className={`w-px h-full ${isResizingSidebar ? "bg-white/25" : "bg-white/10"}`} />
        </div>
      )}

      {typeof window !== "undefined" && openAgentMenuAgent && agentMenuPosition && createPortal(
        <div
          ref={agentMenuPanelRef}
          className="fixed bg-[#2f2f2f] border border-white/10 rounded-lg shadow-2xl overflow-hidden z-[120] animate-in fade-in slide-in-from-top-1 duration-150 min-w-[180px]"
          style={{
            top: `${agentMenuPosition.top}px`,
            left: `${agentMenuPosition.left}px`,
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditingAgent(openAgentMenuAgent);
              setIsHiringOpen(true);
              setAgentMenuOpen(null);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[#ececec] hover:bg-[#424242] transition-colors"
          >
            <Pencil size={12} />
            <span>Edit Cat</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteAgent(openAgentMenuAgent);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={12} />
            <span>Release into the Wild</span>
          </button>
        </div>,
        document.body,
      )}

      {typeof window !== "undefined" && openSquadMenuSquad && squadMenuPosition && createPortal(
        <div
          ref={squadMenuPanelRef}
          className="fixed bg-[#2f2f2f] border border-white/10 rounded-lg shadow-2xl overflow-hidden z-[120] animate-in fade-in slide-in-from-top-1 duration-150 min-w-[220px]"
          style={{
            top: `${squadMenuPosition.top}px`,
            left: `${squadMenuPosition.left}px`,
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleSaveSquadAsBlueprint(openSquadMenuSquad);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[#ececec] hover:bg-[#424242] transition-colors"
          >
            <BookmarkPlus size={12} />
            <span>Save as Blueprint</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleExportSquadBlueprint(openSquadMenuSquad);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[#ececec] hover:bg-[#424242] transition-colors"
          >
            <Download size={12} />
            <span>Export Blueprint JSON</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleEditSquad(openSquadMenuSquad);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[#ececec] hover:bg-[#424242] transition-colors"
          >
            <Pencil size={12} />
            <span>Edit Squad</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteSquad(openSquadMenuSquad);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={12} />
            <span>Disband Squad</span>
          </button>
        </div>,
        document.body,
      )}

      {/* Main Content */}
      <div className="flex-1 min-w-0 flex flex-col h-full relative bg-[#212121]">

        {/* Toggle Sidebar Button (Mobile/Desktop) */}
        {!sidebarOpen && (
          <div className="absolute top-4 left-4 z-50">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 bg-[#212121] border border-white/10 rounded-md text-[#ececec] hover:bg-[#2f2f2f] shadow-lg"
            >
              <PanelLeftClose size={20} className="rotate-180" />
            </button>
          </div>
        )}
        {sidebarOpen && (
          <div className="absolute top-3 left-2 z-50 md:hidden">
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-2 text-[#8e8ea0] hover:text-white"
            >
              <PanelLeftClose size={20} />
            </button>
          </div>
        )}


        {/* Chat Area */}
        <div className="flex-1 h-full relative">
          {/* API Key Modal Overlay */}
          {!hasAnyApiKeyConfigured && (
            <div className="absolute inset-0 z-[60] bg-[#212121]/80 backdrop-blur-sm flex items-center justify-center">
              <div className="bg-[#2f2f2f] border border-white/10 p-8 rounded-2xl shadow-2xl max-w-md w-full text-center">
                <div className="w-16 h-16 bg-[#10a37f]/20 text-[#10a37f] rounded-full flex items-center justify-center mx-auto mb-6">
                  <PawPrint size={32} />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">Welcome to CatGPT</h2>
                <p className="text-[#b4b4b4] mb-6 text-sm">
                  Please provide your API Key to initialize the neural pathways.
                </p>
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="bg-[#10a37f] hover:bg-[#1a7f64] text-white font-medium px-6 py-3 rounded-lg w-full transition-colors"
                >
                  Connect API Key
                </button>
              </div>
            </div>
          )}

          {showChatAgentSelector && (
            <div className="absolute top-4 left-16 md:left-4 z-50">
              <div ref={chatSelectorMenuRef} className="relative">
                <button
                  onClick={() => {
                    setChatSelectorMenuOpen((prev) => {
                      const next = !prev;
                      if (!next) setChatSelectorSubmenu(null);
                      return next;
                    });
                  }}
                  className="bg-[#171717]/95 border border-white/10 rounded-lg px-2.5 py-1.5 shadow-lg backdrop-blur-sm flex items-center gap-2 text-left hover:bg-[#1e1e1e] transition-colors"
                >
                  <div className="max-w-[220px] min-w-0">
                    <div className="text-xs text-[#ececec] truncate">{activeChatCatLabel}</div>
                    <div className="text-[11px] text-[#8e8ea0] truncate">
                      {displayedModelLabel}
                    </div>
                  </div>
                  <ChevronDown size={14} className={`text-[#8e8ea0] transition-transform ${chatSelectorMenuOpen ? "rotate-180" : ""}`} />
                </button>

                {chatSelectorMenuOpen && (
                  <div className="absolute top-[calc(100%+0.5rem)] left-0 w-[220px] bg-[#171717] border border-white/10 rounded-xl shadow-2xl p-1.5 space-y-1">
                    <div className="relative">
                      <button
                        onMouseEnter={() => setChatSelectorSubmenu("cat")}
                        onClick={() => setChatSelectorSubmenu((prev) => (prev === "cat" ? null : "cat"))}
                        className={`w-full px-2.5 py-2 rounded-lg text-sm flex items-center justify-between transition-colors ${chatSelectorSubmenu === "cat" ? "bg-[#2a2a2a] text-white" : "text-[#d4d4d8] hover:bg-[#232323]"}`}
                      >
                        <span>Cat Selector</span>
                        <ChevronRight size={14} className="text-[#8e8ea0]" />
                      </button>

                      {chatSelectorSubmenu === "cat" && (
                        <div className="absolute left-0 md:left-[calc(100%+0.5rem)] top-[calc(100%+0.35rem)] md:top-0 w-[250px] max-w-[calc(100vw-2rem)] bg-[#171717] border border-white/10 rounded-xl shadow-2xl p-1.5 max-h-[360px] overflow-y-auto custom-scrollbar">
                          {chatCatOptions.map((option) => {
                            const isSelected = activeConversationAgentSelectorValue === option.value;
                            return (
                              <button
                                key={option.value}
                                disabled={option.disabled}
                                onClick={() => handleSwitchConversationAgent(option.value)}
                                className={`w-full px-2.5 py-2 rounded-lg text-sm flex items-center justify-between transition-colors text-left ${isSelected
                                  ? "bg-[#2f2f2f] text-white"
                                  : "text-[#d4d4d8] hover:bg-[#232323]"
                                  } ${option.disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                              >
                                <span className="truncate pr-2">{option.label}</span>
                                {isSelected && <Check size={14} className="text-[#10a37f] flex-shrink-0" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="relative">
                      <button
                        disabled={!canSelectModel}
                        onMouseEnter={() => {
                          if (!canSelectModel) return;
                          setChatSelectorSubmenu("model");
                        }}
                        onClick={() => {
                          if (!canSelectModel) return;
                          setChatSelectorSubmenu((prev) => (prev === "model" ? null : "model"));
                        }}
                        className={`w-full px-2.5 py-2 rounded-lg text-sm flex items-center justify-between transition-colors ${chatSelectorSubmenu === "model" ? "bg-[#2a2a2a] text-white" : "text-[#d4d4d8] hover:bg-[#232323]"} ${!canSelectModel ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <span>Model Selector</span>
                        <ChevronRight size={14} className="text-[#8e8ea0]" />
                      </button>

                      {chatSelectorSubmenu === "model" && (
                        <div className="absolute left-0 md:left-[calc(100%+0.5rem)] top-[calc(100%+0.35rem)] md:top-0 w-[360px] max-w-[calc(100vw-2rem)] bg-[#171717] border border-white/10 rounded-xl shadow-2xl p-2 max-h-[420px] overflow-y-auto custom-scrollbar">
                          {modelSelectionProviders.map((provider) => (
                            <div key={provider.id} className="mb-2 last:mb-0">
                              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[#8e8ea0]">
                                {provider.name}
                              </div>
                              <div className="space-y-1">
                                {provider.models.map((model) => {
                                  const isSelected = selectedModelProviderId === provider.id && selectedModelId === model.id;
                                  const badges = getModelBadges(model);
                                  return (
                                    <button
                                      key={`${provider.id}-${model.id}`}
                                      onClick={() => {
                                        if (!modelSelectionAgent?.id) return;
                                        handleSelectModelForAgent(modelSelectionAgent.id, provider.id, model.id);
                                      }}
                                      className={`w-full px-2 py-1.5 rounded-md text-left transition-colors ${isSelected ? "bg-[#2f2f2f] border border-[#10a37f]/40" : "hover:bg-[#232323] border border-transparent"}`}
                                    >
                                      <div className="text-xs text-[#ececec] flex items-center justify-between gap-2">
                                        <span className="truncate">{model.label}</span>
                                        {isSelected && <Check size={13} className="text-[#10a37f] flex-shrink-0" />}
                                      </div>
                                      {model.description && (
                                        <div className="text-[11px] text-[#8e8ea0] truncate">{model.description}</div>
                                      )}
                                      {badges.length > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                          {badges.map((badge) => (
                                            <span
                                              key={`${provider.id}-${model.id}-${badge}`}
                                              className="px-1.5 py-0.5 rounded border border-white/15 bg-[#252525] text-[10px] text-[#b4b4b4]"
                                            >
                                              {badge}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="relative">
                      <button
                        disabled={!canSelectReasoning}
                        onMouseEnter={() => {
                          if (!canSelectReasoning) return;
                          setChatSelectorSubmenu("reasoning");
                        }}
                        onClick={() => {
                          if (!canSelectReasoning) return;
                          setChatSelectorSubmenu((prev) => (prev === "reasoning" ? null : "reasoning"));
                        }}
                        className={`w-full px-2.5 py-2 rounded-lg text-sm flex items-center justify-between transition-colors ${chatSelectorSubmenu === "reasoning" ? "bg-[#2a2a2a] text-white" : "text-[#d4d4d8] hover:bg-[#232323]"} ${!canSelectReasoning ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <span>Reasoning Effort</span>
                        <ChevronRight size={14} className="text-[#8e8ea0]" />
                      </button>

                      {chatSelectorSubmenu === "reasoning" && (
                        <div className="absolute left-0 md:left-[calc(100%+0.5rem)] top-[calc(100%+0.35rem)] md:top-0 w-[250px] max-w-[calc(100vw-2rem)] bg-[#171717] border border-white/10 rounded-xl shadow-2xl p-2 space-y-1">
                          {REASONING_EFFORT_OPTIONS.map((option) => {
                            const isSelected = effectiveSelectedReasoningEffort === option.id;
                            return (
                              <button
                                key={option.id}
                                onClick={() => {
                                  if (!modelSelectionAgent?.id) return;
                                  handleSelectReasoningForAgent(modelSelectionAgent.id, option.id);
                                }}
                                className={`w-full px-2 py-1.5 rounded-md text-left transition-colors ${isSelected ? "bg-[#2f2f2f] border border-[#10a37f]/40" : "hover:bg-[#232323] border border-transparent"}`}
                              >
                                <div className="text-xs text-[#ececec] flex items-center justify-between gap-2">
                                  <span>{option.label}</span>
                                  {isSelected && <Check size={13} className="text-[#10a37f] flex-shrink-0" />}
                                </div>
                                <div className="text-[11px] text-[#8e8ea0]">{option.description}</div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {runtimeActiveChatAgent ? (
            <ChatInterface
              key={`${activeConversationId || "draft"}-${runtimeActiveChatAgent.id || "agent"}-${runtimeActiveChatAgent.provider || "provider"}-${runtimeActiveChatAgent.model || "model"}-${runtimeActiveChatAgent.reasoningEffort || DEFAULT_REASONING_EFFORT}`}
              agent={runtimeActiveChatAgent}
              participantAgents={selectedSquad ? squadParticipants : (runtimeActiveChatAgent ? [runtimeActiveChatAgent] : [])}
              interactionMode={selectedSquadInteraction?.mode}
              messages={currentMessages}
              onSendMessage={handleSendMessage}
              onRegenerateFromError={handleRegenerateFromError}
              isProcessing={isProcessing}
              slashCommands={SLASH_COMMANDS}
              showDefaultAgentLanding={isDefaultAgentChat}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-[#8e8ea0] text-sm">
              No chat agents available.
            </div>
          )}

          {shouldShowMasterLog && (
            <div className="absolute top-4 right-4 z-50 flex flex-col items-end gap-2">
              <button
                onClick={() => setIsMasterLogOpen((prev) => !prev)}
                className="px-3 py-2 bg-[#2f2f2f] border border-white/10 rounded-lg text-xs text-[#ececec] hover:bg-[#3a3a3a] transition-colors flex items-center gap-2"
              >
                <ListTree size={14} />
                {isMasterLogOpen ? "Hide Master Log" : "Show Master Log"}
              </button>

              {isMasterLogOpen && (
                <div className="w-[calc(100vw-2rem)] sm:w-[380px] max-h-[75vh] bg-[#171717] border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col">
                  <div className="px-4 py-3 border-b border-white/10 bg-[#1f1f1f]">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-white">Master Log</div>
                      {isLiveRunActive && (
                        <div className="text-[10px] px-2 py-1 rounded border text-[#7aa2f7] bg-[#7aa2f7]/10 border-[#7aa2f7]/20">
                          Live · {liveStepCount} step{liveStepCount === 1 ? "" : "s"} · {liveElapsed}
                        </div>
                      )}
                    </div>
                    <div className="text-[11px] text-[#8e8ea0]">
                      Orchestrator decisions and worker collaboration trace
                    </div>
                  </div>

                  <div className="p-3 overflow-y-auto custom-scrollbar space-y-3">
                    {currentSquadTrace.length === 0 && (
                      <div className="text-xs text-[#8e8ea0] bg-[#212121] border border-white/10 rounded-lg p-3">
                        No orchestration trace yet. Send a squad task to populate this panel.
                      </div>
                    )}

                    {[...currentSquadTrace].reverse().map((turn, turnIndex) => (
                      <div key={turn.id} className="bg-[#212121] border border-white/10 rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-[#ececec]">
                            Turn {currentSquadTrace.length - turnIndex}
                          </span>
                          <span className={`text-[10px] px-2 py-1 rounded border ${getTraceStatusColor(turn.status)}`}>
                            {turn.status.replaceAll("_", " ")}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#b4b4b4]">
                          {new Date(turn.timestamp).toLocaleString()}
                        </div>
                        <div className="text-xs text-[#c0caf5] leading-relaxed">
                          <span className="text-[#8e8ea0]">User:</span> {turn.userMessage}
                        </div>

                        <div className="space-y-2 pt-1">
                          {turn.steps.map((step) => (
                            <div key={`${turn.id}-${step.iteration}`} className="border border-white/10 rounded-md p-2 bg-[#171717]">
                              <div className="text-[11px] text-[#8e8ea0] mb-1">Iteration {step.iteration}</div>
                              <div className="text-xs text-[#ececec]">
                                <span className="text-[#8e8ea0]">Orchestrator:</span> {step.directorDecision.summary}
                              </div>
                              <div className="text-[11px] text-[#b4b4b4] mt-1">
                                Status: {step.directorDecision.status}
                              </div>
                              {step.workerAgentName && (
                                <div className="mt-2 text-xs text-[#9ece6a]">
                                  Worker: {step.workerAgentName}
                                </div>
                              )}
                              {step.workerInstruction && (
                                <div className="text-[11px] text-[#c0caf5] mt-1">
                                  Task: {step.workerInstruction}
                                </div>
                              )}
                              {step.workerOutput && (
                                <pre className="mt-2 text-[11px] text-[#b4b4b4] whitespace-pre-wrap bg-black/30 border border-white/10 rounded p-2">
                                  {step.workerOutput}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      {isHiringOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-[#1f1f1f] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
            <AgentEditor
              initialData={editingAgent}
              onSave={(newAgent) => {
                if (editingAgent) {
                  saveAgents(agents.map(a => a.id === newAgent.id ? newAgent : a));
                } else {
                  saveAgents([...agents, { ...newAgent, id: uuidv4() }]);
                }
                setIsHiringOpen(false);
              }}
              onCancel={() => setIsHiringOpen(false)}
            />
          </div>
        </div>
      )}

      {isSquadEditorOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="w-full max-w-3xl">
            <SquadEditor
              initialData={editingSquad}
              availableAgents={availableAgentsForSquadEditor}
              onCreateSquadAgents={handleCreateSquadAgents}
              onUpsertSquadAgent={handleUpsertSquadAgent}
              onDeleteSquadAgent={handleDeleteSquadAgent}
              onSave={(newSquad) => {
                const validMembers = newSquad.members.filter((memberId) => (
                  squadAgents.some((agent) => agent.id === memberId)
                ));
                const normalizedSquad = normalizeSquadConfig({ ...newSquad, members: validMembers });
                if (editingSquad?.id) {
                  saveSquads(squads.map((s) => s.id === editingSquad.id ? { ...normalizedSquad, id: editingSquad.id } : s));
                } else {
                  saveSquads([...squads, { ...normalizedSquad, id: uuidv4() }]);
                }
                setIsSquadEditorOpen(false);
                setEditingSquad(undefined);
              }}
              onCancel={() => {
                setIsSquadEditorOpen(false);
                setEditingSquad(undefined);
              }}
            />
          </div>
        </div>
      )}

      <SquadBlueprintLibraryModal
        isOpen={isBlueprintLibraryOpen}
        defaultBlueprints={DEFAULT_SQUAD_BLUEPRINTS}
        savedBlueprints={savedSquadBlueprints}
        availableProviderIds={llmProviders.filter((provider) => hasProviderKeyConfigured(provider.id)).map((provider) => provider.id)}
        providerNameById={Object.fromEntries(llmProviders.map((provider) => [provider.id, provider.name]))}
        onClose={() => setIsBlueprintLibraryOpen(false)}
        onImportBlueprint={handleImportBlueprint}
        onDeleteSavedBlueprint={handleDeleteSavedBlueprint}
        onExportBlueprint={downloadBlueprint}
        onImportJson={handleImportBlueprintJson}
      />
    </div>
  );
}
