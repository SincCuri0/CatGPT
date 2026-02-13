"use client";

import { useState, useEffect } from "react";
import { useSettings } from "@/hooks/useSettings";
import { AgentConfig, AgentStyle } from "@/lib/core/Agent";
import { SquadConfig, SquadRunStep, getSquadInteractionConfig, normalizeSquadConfig } from "@/lib/core/Squad";
import { Message } from "@/lib/core/types";
import { SettingsModal } from "@/components/SettingsModal";
import { AgentEditor } from "@/components/agent/AgentEditor";
import { SquadEditor } from "@/components/agent/SquadEditor";
import { ChatInterface, SlashCommandOption } from "@/components/ChatInterface";
import defaultAgents from "@/lib/templates/default_agents.json";
import { Settings, Plus, PawPrint, MessageSquare, PanelLeftClose, MoreHorizontal, Pencil, Trash2, Clock, Cat, Users, ListTree } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { getAgentPersonality } from "@/lib/agentPersonality";
import { PROVIDERS } from "@/lib/llm/constants";
import {
  Conversation,
  SquadTraceTurn,
  loadConversations,
  upsertConversation,
  deleteConversation as deleteConv,
  renameConversation,
  generateTitle,
} from "@/lib/conversations";

const TEMPLATE_AGENTS = defaultAgents as AgentConfig[];
const TEMPLATE_DEFAULT_AGENT =
  TEMPLATE_AGENTS.find((agent) => agent.name?.trim().toLowerCase() === "default agent") ||
  TEMPLATE_AGENTS[0];
const DEFAULT_PROVIDER_ID = "groq";
const DEFAULT_MODEL_ID = "llama-3.3-70b-versatile";
const DEFAULT_VOICE_ID = "en-US-ChristopherNeural";
const VALID_AGENT_STYLES = new Set<AgentStyle>(["assistant", "character", "expert", "custom"]);
const ALLOWED_TOOL_IDS = new Set(["web_search", "fs_read", "fs_write", "shell_execute"]);

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

const normalizeSquadList = (raw: unknown): SquadConfig[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is SquadConfig => Boolean(entry && typeof entry === "object"))
    .map((entry) => normalizeSquadConfig(entry));
};

const normalizeTraceStatus = (status: unknown): SquadTraceTurn["status"] => {
  const value = String(status || "completed");
  if (value === "needs_user_input" || value === "blocked" || value === "max_iterations") {
    return value;
  }
  return "completed";
};

export default function CEODashboard() {
  const { apiKey, apiKeys, serverConfiguredKeys } = useSettings();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [squads, setSquads] = useState<SquadConfig[]>([]);
  const hasAnyApiKeyConfigured =
    Object.values(apiKeys).some((k) => Boolean(k && k.trim())) ||
    Object.values(serverConfiguredKeys).some(Boolean);

  // Selection
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
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

  // Loading State
  const [isProcessing, setIsProcessing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [agentMenuOpen, setAgentMenuOpen] = useState<string | null>(null);
  const [squadMenuOpen, setSquadMenuOpen] = useState<string | null>(null);
  const [chatMenuOpen, setChatMenuOpen] = useState<string | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Load agents on mount
  useEffect(() => {
    const storedAgents = localStorage.getItem("cat_gpt_agents");
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

    setAgents(loadedAgents);

    const defaultAgentId = resolveDefaultAgentId(loadedAgents);
    if (defaultAgentId) {
      setSelectedAgentId(defaultAgentId);
      setSelectedSquadId(null);
    }
  }, []);

  // Load squads on mount
  useEffect(() => {
    const storedSquads = localStorage.getItem("cat_gpt_squads");
    if (storedSquads) {
      try {
        setSquads(normalizeSquadList(JSON.parse(storedSquads)));
      } catch {
        setSquads([]);
      }
    }
  }, []);

  // Warm ElevenLabs voices cache on app load so voice options are ready in editors.
  useEffect(() => {
    fetch("/api/elevenlabs/voices")
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
  }, []);

  // Load ALL conversations on mount
  useEffect(() => {
    setConversations(loadConversations().sort((a, b) => b.updatedAt - a.updatedAt));
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

  const saveAgents = (newAgents: AgentConfig[]) => {
    setAgents(newAgents);
    localStorage.setItem("cat_gpt_agents", JSON.stringify(newAgents));
  };

  const saveSquads = (newSquads: SquadConfig[]) => {
    const normalized = normalizeSquadList(newSquads);
    setSquads(normalized);
    localStorage.setItem("cat_gpt_squads", JSON.stringify(normalized));
  };

  const refreshConversations = () => {
    setConversations(loadConversations().sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const hasProviderKeyConfigured = (providerId: string): boolean => {
    const localKey = apiKeys[providerId];
    if (typeof localKey === "string" && localKey.trim().length > 0) return true;

    const envKey = PROVIDER_ENV_KEY_MAP[providerId];
    if (envKey && serverConfiguredKeys[envKey]) return true;
    if (serverConfiguredKeys[providerId]) return true;
    return false;
  };

  const resolveCreateCatsProvider = (preferredProvider?: string, preferredModel?: string): { provider: string; model: string } => {
    const providerIds = PROVIDERS.map((provider) => provider.id);
    const normalizedPreferred = (preferredProvider || "").trim().toLowerCase();
    const searchOrder = [
      ...(normalizedPreferred ? [normalizedPreferred] : []),
      ...providerIds.filter((providerId) => providerId !== normalizedPreferred),
    ];

    const providerWithKey = searchOrder.find((providerId) => hasProviderKeyConfigured(providerId));
    const provider = providerWithKey || DEFAULT_PROVIDER_ID;
    const model = provider === normalizedPreferred && preferredModel?.trim()
      ? preferredModel.trim()
      : defaultModelForProvider(provider);

    return { provider, model };
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

  const executeCreateCatsCommand = async (
    prompt: string,
    preferredProvider?: string,
    preferredModel?: string,
  ): Promise<{ role: "assistant" | "system"; content: string }> => {
    const { provider, model } = resolveCreateCatsProvider(preferredProvider, preferredModel);
    const response = await fetch("/api/agents/create-cats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-groq-api-key": apiKey || "",
        "x-api-keys": JSON.stringify(apiKeys),
      },
      body: JSON.stringify({
        prompt,
        provider,
        model,
        existingAgents: agents.map((agent) => ({
          name: agent.name,
          role: agent.role,
        })),
      }),
    });

    const data = await response.json() as (CreateCatsApiResponse & { error?: string; details?: string });
    if (!response.ok || data.error) {
      throw new Error(data.error || data.details || "Failed to run /create_cats.");
    }

    if (data.action === "request_information") {
      return {
        role: "assistant",
        content: data.question.trim() || "Please share what you want these new cat agents to do.",
      };
    }

    const generatedAgents = Array.isArray(data.agents) ? data.agents : [];
    if (generatedAgents.length === 0) {
      return {
        role: "assistant",
        content: "I couldn't generate any usable agent instructions yet. Tell me what responsibilities these cats should cover.",
      };
    }

    const takenNames = new Set(agents.map((agent) => (agent.name || "").toLowerCase()));
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
      const resolvedProvider = PROVIDERS.some((candidate) => candidate.id === providerId)
        ? providerId
        : provider;
      const resolvedModel = (typeof generated.model === "string" && generated.model.trim())
        ? generated.model.trim()
        : defaultModelForProvider(resolvedProvider);
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
      const tools = Array.isArray(generated.tools)
        ? generated.tools
          .filter((tool): tool is string => typeof tool === "string")
          .map((tool) => tool.trim())
          .filter((tool) => Boolean(tool) && ALLOWED_TOOL_IDS.has(tool))
        : [];

      return {
        id: uuidv4(),
        name,
        role,
        description: description.slice(0, 120),
        style,
        systemPrompt,
        provider: resolvedProvider,
        model: resolvedModel,
        voiceId,
        tools,
      };
    });

    const updatedAgents = [...agents, ...createdAgents];
    saveAgents(updatedAgents);

    const summary = typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim()
      : `Created ${createdAgents.length} new cat agent${createdAgents.length > 1 ? "s" : ""}.`;
    const createdList = createdAgents
      .map((agent) => `- **${agent.name}** (${agent.role})`)
      .join("\n");

    return {
      role: "assistant",
      content: `${summary}\n\nAdded to your litter:\n${createdList}`,
    };
  };

  const executeSlashCommand = async (
    command: ParsedSlashCommand,
    targetAgent?: AgentConfig,
    targetSquad?: SquadConfig,
  ): Promise<{ role: "assistant" | "system"; content: string }> => {
    if (command.name === "/create_cats") {
      const squadDirector = targetSquad
        ? agents.find((agent) => agent.id === targetSquad.directorId)
        : undefined;

      return executeCreateCatsCommand(
        command.args,
        targetAgent?.provider || squadDirector?.provider,
        targetAgent?.model || squadDirector?.model,
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
    setAgentMenuOpen(null);
    setSquadMenuOpen(null);
    setChatMenuOpen(null);
    // Start fresh (no active conversation — shows agent landing page)
    setActiveConversationId(null);
    setCurrentMessages([]);
    setCurrentSquadTrace([]);
    setIsMasterLogOpen(false);
  };

  const handleSelectSquad = (squadId: string) => {
    setSelectedSquadId(squadId);
    setSelectedAgentId(null);
    setAgentMenuOpen(null);
    setSquadMenuOpen(null);
    setChatMenuOpen(null);
    setActiveConversationId(null);
    setCurrentMessages([]);
    setCurrentSquadTrace([]);
  };

  const handleNewChat = () => {
    setActiveConversationId(null);
    setCurrentMessages([]);
    setCurrentSquadTrace([]);
    setSquadMenuOpen(null);
    setChatMenuOpen(null);
    setIsMasterLogOpen(false);

    if (!selectedAgentId && !selectedSquadId) {
      const defaultAgentId = resolveDefaultAgentId(agents);
      if (defaultAgentId) {
        setSelectedAgentId(defaultAgentId);
      }
    }
  };

  const handleSelectConversation = (convId: string) => {
    const conv = conversations.find(c => c.id === convId);
    if (conv) {
      let found = false;
      const linkedAgent = agents.find((a) => a.id === conv.agentId);
      if (linkedAgent) {
        setSelectedAgentId(linkedAgent.id || null);
        setSelectedSquadId(null);
        found = true;
      } else {
        const linkedSquad = squads.find((s) => s.id === conv.agentId);
        if (linkedSquad) {
          setSelectedSquadId(linkedSquad.id || null);
          setSelectedAgentId(null);
          found = true;
        }
      }
      if (!found) {
        setSelectedAgentId(null);
        setSelectedSquadId(null);
      }
    }
    setActiveConversationId(convId);
    setSquadMenuOpen(null);
    setChatMenuOpen(null);
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

  const handleDeleteSquad = (squad: SquadConfig) => {
    const confirmed = window.confirm(`Disband squad "${squad.name}"?`);
    if (!confirmed) {
      setSquadMenuOpen(null);
      return;
    }

    const updatedSquads = squads.filter((s) => s.id !== squad.id);
    saveSquads(updatedSquads);

    if (selectedSquadId === squad.id) {
      setSelectedSquadId(null);
      setActiveConversationId(null);
      setCurrentMessages([]);
      setCurrentSquadTrace([]);
      setIsMasterLogOpen(false);
    }

    const activeConversation = conversations.find((c) => c.id === activeConversationId);
    if (activeConversation && activeConversation.agentId === squad.id) {
      setActiveConversationId(null);
      setCurrentMessages([]);
      setCurrentSquadTrace([]);
      setIsMasterLogOpen(false);
    }

    setSquadMenuOpen(null);
  };

  const createAgentAssistantMessage = (
    content: string,
    speaker: AgentConfig | undefined,
    fallbackName: string,
    interactionConfig?: ReturnType<typeof getSquadInteractionConfig>,
  ): Message => {
    const style = speaker?.style && VALID_AGENT_STYLES.has(speaker.style) ? speaker.style : "assistant";
    const isCharacter = style === "character";
    const allowCharacterTypewriter = Boolean(interactionConfig?.typewriterCharacterMessages);
    const allowCharacterAutoplay = Boolean(interactionConfig?.autoPlayCharacterVoices);

    return {
      id: uuidv4(),
      role: "assistant",
      name: speaker?.name || fallbackName,
      content,
      timestamp: Date.now(),
      agentId: speaker?.id,
      agentStyle: style,
      voiceId: speaker?.voiceId || DEFAULT_VOICE_ID,
      typewriter: allowCharacterTypewriter && isCharacter,
      autoPlay: allowCharacterAutoplay && isCharacter,
    };
  };

  const buildSquadStepMessages = (
    squad: SquadConfig,
    stepList: SquadRunStep[],
  ): Message[] => {
    const interactionConfig = getSquadInteractionConfig(squad);
    if (!interactionConfig.showAgentMessagesInChat || stepList.length === 0) {
      return [];
    }

    const participants = agents.filter((agent) => {
      const id = agent.id || "";
      return id === squad.directorId || squad.members.includes(id);
    });
    const byId = new Map(participants.map((agent) => [agent.id || "", agent]));
    const director = byId.get(squad.directorId);
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
              director,
              "Director",
              interactionConfig,
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
            interactionConfig,
          ),
        );
      }
    }

    return output;
  };

  const handleSendMessage = async (text: string) => {
    if ((!selectedAgentId && !selectedSquadId) || !hasAnyApiKeyConfigured) return;

    const slashCommand = parseSlashCommand(text);
    const targetAgent = selectedAgentId ? agents.find(a => a.id === selectedAgentId) : undefined;
    const targetSquadRaw = selectedSquadId ? squads.find(s => s.id === selectedSquadId) : undefined;
    const targetSquad = targetSquadRaw ? normalizeSquadConfig(targetSquadRaw) : undefined;
    const isSquadMode = Boolean(targetSquad);
    if (!targetAgent && !targetSquad) return;

    const selectedParticipantId = selectedAgentId || selectedSquadId || null;
    if (!selectedParticipantId) return;

    // Create or use existing conversation
    let convId = activeConversationId;
    let isNew = false;

    if (!convId) {
      // Create new conversation
      convId = uuidv4();
      isNew = true;
    }

    const newUserMsg: Message = {
      id: uuidv4(),
      role: "user",
      content: text,
      timestamp: Date.now()
    };

    const updatedMessages = [...currentMessages, newUserMsg];
    const existingTrace = currentSquadTrace;
    setCurrentMessages(updatedMessages);
    setActiveConversationId(convId);

    // Save conversation immediately (so it appears in history)
    const conv: Conversation = {
      id: convId,
      agentId: selectedParticipantId,
      title: isNew ? generateTitle(text) : (conversations.find(c => c.id === convId)?.title || generateTitle(text)),
      messages: updatedMessages,
      squadTrace: existingTrace,
      createdAt: isNew ? Date.now() : (conversations.find(c => c.id === convId)?.createdAt || Date.now()),
      updatedAt: Date.now(),
    };
    upsertConversation(conv);
    refreshConversations();

    setIsProcessing(true);

    try {
      if (slashCommand) {
        const commandResult = await executeSlashCommand(slashCommand, targetAgent, targetSquad);
        const commandReply: Message = {
          id: uuidv4(),
          role: commandResult.role,
          name: commandResult.role === "assistant"
            ? (targetAgent?.name || targetSquad?.name || "System")
            : undefined,
          content: commandResult.content,
          timestamp: Date.now(),
        };

        const finalMessages = [...updatedMessages, commandReply];
        setCurrentMessages(finalMessages);
        setCurrentSquadTrace(existingTrace);

        upsertConversation({
          ...conv,
          messages: finalMessages,
          squadTrace: existingTrace,
          updatedAt: Date.now(),
        });
        refreshConversations();
        return;
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-groq-api-key": apiKey || "",
          "x-api-keys": JSON.stringify(apiKeys),
        },
        body: JSON.stringify({
          message: text,
          history: currentMessages,
          ...(isSquadMode
            ? { squadConfig: targetSquad, agents }
            : { agentConfig: targetAgent })
        })
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      const responseText = typeof data.response === "string" ? data.response : "";
      const squadSteps = Array.isArray(data.squadSteps) ? (data.squadSteps as SquadRunStep[]) : [];
      const interactionConfig = targetSquad ? getSquadInteractionConfig(targetSquad) : undefined;
      const visibleStepMessages = targetSquad ? buildSquadStepMessages(targetSquad, squadSteps) : [];

      const finalAssistantMessages: Message[] = [];
      if (isSquadMode && targetSquad) {
        finalAssistantMessages.push(...visibleStepMessages);
      }

      if (!isSquadMode) {
        finalAssistantMessages.push(
          createAgentAssistantMessage(responseText, targetAgent, targetAgent?.name || "Assistant"),
        );
      } else if (targetSquad) {
        const director = agents.find((agent) => agent.id === targetSquad.directorId);
        const lastVisibleMessage = finalAssistantMessages[finalAssistantMessages.length - 1];
        const shouldAppendFinal = responseText.trim().length > 0
          && (!lastVisibleMessage || lastVisibleMessage.content.trim() !== responseText.trim());

        if (shouldAppendFinal || finalAssistantMessages.length === 0) {
          finalAssistantMessages.push(
            createAgentAssistantMessage(
              responseText || "The squad completed this turn.",
              director,
              director?.name || targetSquad.name,
              interactionConfig,
            ),
          );
        }
      }

      const finalMessages = [...updatedMessages, ...finalAssistantMessages];
      setCurrentMessages(finalMessages);
      let finalTrace = existingTrace;
      if (isSquadMode && squadSteps.length > 0) {
        const normalizedStatus = normalizeTraceStatus(data.squadStatus);
        const traceTurn: SquadTraceTurn = {
          id: uuidv4(),
          timestamp: Date.now(),
          userMessage: text,
          status: normalizedStatus,
          steps: squadSteps,
        };
        finalTrace = [...existingTrace, traceTurn];
      }
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
      console.error("Chat Failed", e);
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      const errorMsg: Message = {
        id: uuidv4(),
        role: "system",
        content: `Hiss! Something went wrong. ${errorMessage}`,
        timestamp: Date.now()
      };
      const finalMessages = [...updatedMessages, errorMsg];
      setCurrentMessages(finalMessages);

      upsertConversation({
        ...conv,
        messages: finalMessages,
        squadTrace: existingTrace,
        updatedAt: Date.now(),
      });
      refreshConversations();
    } finally {
      setIsProcessing(false);
    }
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
  const selectedSquadRaw = selectedSquadId ? squads.find((s) => s.id === selectedSquadId) : undefined;
  const selectedSquad = selectedSquadRaw ? normalizeSquadConfig(selectedSquadRaw) : undefined;
  const selectedSquadInteraction = selectedSquad ? getSquadInteractionConfig(selectedSquad) : undefined;
  const squadDirector = selectedSquad ? agents.find((a) => a.id === selectedSquad.directorId) : undefined;
  const squadParticipants = selectedSquad
    ? agents.filter((agent) => {
      const id = agent.id || "";
      return id === selectedSquad.directorId || selectedSquad.members.includes(id);
    })
    : [];
  const selectedSquadChatAgent: AgentConfig | null = selectedSquad ? {
    id: selectedSquad.id,
    name: selectedSquad.name,
    role: "Squad Orchestrator",
    systemPrompt: selectedSquad.mission || "Coordinate worker agents to complete tasks.",
    style: squadDirector?.style || "assistant",
    voiceId: squadDirector?.voiceId || "en-US-ChristopherNeural",
    provider: squadDirector?.provider || "groq",
    model: squadDirector?.model || "llama-3.3-70b-versatile",
    tools: [],
  } : null;
  const selectedAgent = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) : undefined;
  const activeChatAgent = selectedAgent || selectedSquadChatAgent;
  const shouldShowMasterLog = Boolean(selectedSquad && selectedSquadInteraction?.showMasterLog);

  const getTraceStatusColor = (status: SquadTraceTurn["status"]) => {
    if (status === "completed") return "text-[#9ece6a] bg-[#9ece6a]/10 border-[#9ece6a]/20";
    if (status === "needs_user_input") return "text-[#e0af68] bg-[#e0af68]/10 border-[#e0af68]/20";
    if (status === "blocked") return "text-[#f7768e] bg-[#f7768e]/10 border-[#f7768e]/20";
    return "text-[#7aa2f7] bg-[#7aa2f7]/10 border-[#7aa2f7]/20";
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#212121] text-[#ececec] font-sans">

      {/* Sidebar - Collapsible */}
      <div
        className={`${sidebarOpen ? "w-[260px]" : "w-0"} bg-[#171717] flex flex-col transition-all duration-300 ease-in-out overflow-hidden border-r border-white/5 relative z-30`}
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
            <span className="text-[10px] font-normal text-[#565656]">{agents.length} cats</span>
          </div>

          {/* Agents List */}
          <div className="space-y-1 pr-1 flex-shrink-0 max-h-[40%] overflow-y-auto custom-scrollbar">
            {agents.map(agent => {
              const isSelected = selectedAgentId === agent.id;
              const personality = getAgentPersonality(agent);

              return (
                <div key={agent.id} className="relative">
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

                    {/* Hover tools paw prints (shown when menu is closed) */}
                    {agent.tools && agent.tools.length > 0 && agentMenuOpen !== agent.id && (
                      <div className="flex gap-0.5">
                        {agent.tools.slice(0, 3).map((_, i) => (
                          <span key={i} className="tool-paw text-[10px]">🐾</span>
                        ))}
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
                          setAgentMenuOpen(agentMenuOpen === agent.id ? null : (agent.id || null));
                        }}
                        className="p-1 rounded hover:bg-[#424242] transition-colors cursor-pointer"
                      >
                        <MoreHorizontal size={14} className="text-[#8e8ea0]" />
                      </div>
                    </div>
                  </button>

                  {/* Dropdown Menu */}
                  {agentMenuOpen === agent.id && (
                    <div className="absolute left-11 top-full mt-1 bg-[#2f2f2f] border border-white/10 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-1 duration-150 min-w-[180px]">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingAgent(agent);
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
                          const confirmed = window.confirm(`Release ${agent.name} back into the wild? 🐈`);
                          if (confirmed) {
                            saveAgents(agents.filter(a => a.id !== agent.id));
                            const updatedSquads = squads
                              .filter((s) => s.directorId !== agent.id)
                              .map((s) => ({ ...s, members: s.members.filter((id) => id !== agent.id) }));
                            saveSquads(updatedSquads);
                            if (selectedSquadId && !updatedSquads.some((s) => s.id === selectedSquadId)) {
                              setSelectedSquadId(null);
                            }
                            if (selectedAgentId === agent.id) {
                              setSelectedAgentId(null);
                              setActiveConversationId(null);
                              setCurrentMessages([]);
                            }
                          }
                          setAgentMenuOpen(null);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 size={12} />
                        <span>Release into the Wild</span>
                      </button>
                    </div>
                  )}
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
            <span className="text-[10px] font-normal text-[#565656]">{squads.length}</span>
          </div>

          <div className="space-y-1 pr-1 flex-shrink-0 max-h-[24%] overflow-y-auto custom-scrollbar">
            {squads.map((squad) => {
              const isSelected = selectedSquadId === squad.id;
              const director = agents.find((a) => a.id === squad.directorId);
              const memberCount = squad.members.length;

              return (
                <div key={squad.id} className="relative group">
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
                        {memberCount} members • Director: {director?.name || "Unknown"}
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
                          setSquadMenuOpen(squadMenuOpen === squad.id ? null : (squad.id || null));
                        }}
                        className="p-1 rounded hover:bg-[#424242] transition-colors cursor-pointer"
                      >
                        <MoreHorizontal size={14} className="text-[#8e8ea0]" />
                      </div>
                    </div>
                  </button>

                  {squadMenuOpen === squad.id && (
                    <div className="absolute left-11 top-full mt-1 bg-[#2f2f2f] border border-white/10 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-1 duration-150 min-w-[180px]">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditSquad(squad);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[#ececec] hover:bg-[#424242] transition-colors"
                      >
                        <Pencil size={12} />
                        <span>Edit Squad</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSquad(squad);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 size={12} />
                        <span>Disband Squad</span>
                      </button>
                    </div>
                  )}
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
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-400 to-blue-500 flex items-center justify-center text-white text-xs font-bold border border-white/10">
              HU
            </div>
            <div className="flex-1 truncate font-medium text-[#ececec]">Human User</div>
            <Settings size={16} className="text-[#8e8ea0] group-hover:text-white transition-colors" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full relative bg-[#212121]">

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

          {activeChatAgent ? (
            <ChatInterface
              key={`${activeConversationId || "draft"}-${activeChatAgent.id || "agent"}`}
              agent={activeChatAgent}
              participantAgents={selectedSquad ? squadParticipants : (selectedAgent ? [selectedAgent] : [])}
              messages={currentMessages}
              onSendMessage={handleSendMessage}
              isProcessing={isProcessing}
              slashCommands={SLASH_COMMANDS}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-[#ececec]">
              <div className="mb-8">
                <div className="w-24 h-24 bg-[#2f2f2f] rounded-full flex items-center justify-center mb-6 shadow-2xl skew-y-0 hover:rotate-12 transition-transform duration-500 cursor-cell mx-auto">
                  <Cat size={48} className="text-[#ececec]" />
                </div>
                <h2 className="text-2xl font-semibold mb-2">CatGPT</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl w-full px-6">
                {/* Suggestions */}
                {[
                  "Explain quantum physics to a kitten",
                  "Write a haiku about tuna",
                  "Design a scratching post skyscraper"
                ].map((suggestion, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (agents[0]?.id) {
                        handleSelectAgent(agents[0].id);
                      } else if (squads[0]?.id) {
                        handleSelectSquad(squads[0].id);
                      }
                    }}
                    className="p-4 bg-[#2f2f2f] hover:bg-[#424242] border border-white/5 rounded-xl text-left text-sm text-[#ececec] transition-colors flex items-center justify-between group"
                  >
                    <span>{suggestion}</span>
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                  </button>
                ))}
              </div>
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
                    <div className="text-sm font-semibold text-white">Master Log</div>
                    <div className="text-[11px] text-[#8e8ea0]">
                      Director decisions and worker collaboration trace
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
                                <span className="text-[#8e8ea0]">Director:</span> {step.directorDecision.summary}
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
              availableAgents={agents}
              onSave={(newSquad) => {
                if (editingSquad?.id) {
                  saveSquads(squads.map((s) => s.id === editingSquad.id ? { ...newSquad, id: editingSquad.id } : s));
                } else {
                  saveSquads([...squads, { ...newSquad, id: uuidv4() }]);
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
    </div>
  );
}
