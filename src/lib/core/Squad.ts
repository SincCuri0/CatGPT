import { AgentConfig } from "./Agent";

export type SquadInteractionMode = "master_log" | "live_campaign";
export type SquadUserTurnPolicy = "on_demand" | "every_round";

export interface SquadInteractionConfig {
    mode: SquadInteractionMode;
    showMasterLog: boolean;
    showAgentMessagesInChat: boolean;
    includeDirectorMessagesInChat: boolean;
    autoPlayCharacterVoices: boolean;
    typewriterCharacterMessages: boolean;
    userTurnPolicy: SquadUserTurnPolicy;
}

const MASTER_LOG_INTERACTION_DEFAULTS: SquadInteractionConfig = {
    mode: "master_log",
    showMasterLog: true,
    showAgentMessagesInChat: false,
    includeDirectorMessagesInChat: false,
    autoPlayCharacterVoices: false,
    typewriterCharacterMessages: false,
    userTurnPolicy: "on_demand",
};

const LIVE_CAMPAIGN_INTERACTION_DEFAULTS: SquadInteractionConfig = {
    mode: "live_campaign",
    showMasterLog: false,
    showAgentMessagesInChat: true,
    includeDirectorMessagesInChat: true,
    autoPlayCharacterVoices: true,
    typewriterCharacterMessages: true,
    userTurnPolicy: "every_round",
};

export const DEFAULT_SQUAD_INTERACTION = MASTER_LOG_INTERACTION_DEFAULTS;

export interface SquadConfig {
    id?: string;
    name: string;
    mission: string;
    directorId: string;
    members: string[];
    maxIterations?: number;
    interaction?: Partial<SquadInteractionConfig>;
}

export interface SquadRunStep {
    iteration: number;
    directorDecision: DirectorDecision;
    workerAgentId?: string;
    workerAgentName?: string;
    workerInstruction?: string;
    workerOutput?: string;
}

export interface SquadRunResult {
    status: "completed" | "needs_user_input" | "blocked" | "max_iterations";
    response: string;
    steps: SquadRunStep[];
}

export interface DirectorDecision {
    status: "continue" | "complete" | "needs_user_input" | "blocked";
    summary: string;
    targetAgentId?: string;
    instruction?: string;
    responseToUser?: string;
    userQuestion?: string;
    blockerReason?: string;
}

export interface SquadRuntime {
    config: SquadConfig;
    director: AgentConfig;
    workers: AgentConfig[];
}

function normalizeMode(input: unknown): SquadInteractionMode | null {
    if (input === "master_log" || input === "live_campaign") return input;
    return null;
}

function normalizeTurnPolicy(input: unknown): SquadUserTurnPolicy | null {
    if (input === "on_demand" || input === "every_round") return input;
    return null;
}

function normalizeBoolean(input: unknown, fallback: boolean): boolean {
    return typeof input === "boolean" ? input : fallback;
}

function sanitizeMembers(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input.filter((member): member is string => typeof member === "string" && member.trim().length > 0);
}

export function getSquadInteractionConfig(config?: SquadConfig | null): SquadInteractionConfig {
    const mode = normalizeMode(config?.interaction?.mode) || DEFAULT_SQUAD_INTERACTION.mode;
    const modeDefaults = mode === "live_campaign"
        ? LIVE_CAMPAIGN_INTERACTION_DEFAULTS
        : MASTER_LOG_INTERACTION_DEFAULTS;
    const source = config?.interaction ?? {};

    return {
        mode,
        showMasterLog: normalizeBoolean(source.showMasterLog, modeDefaults.showMasterLog),
        showAgentMessagesInChat: normalizeBoolean(source.showAgentMessagesInChat, modeDefaults.showAgentMessagesInChat),
        includeDirectorMessagesInChat: normalizeBoolean(source.includeDirectorMessagesInChat, modeDefaults.includeDirectorMessagesInChat),
        autoPlayCharacterVoices: normalizeBoolean(source.autoPlayCharacterVoices, modeDefaults.autoPlayCharacterVoices),
        typewriterCharacterMessages: normalizeBoolean(source.typewriterCharacterMessages, modeDefaults.typewriterCharacterMessages),
        userTurnPolicy: normalizeTurnPolicy(source.userTurnPolicy) || modeDefaults.userTurnPolicy,
    };
}

export function normalizeSquadConfig(config: SquadConfig): SquadConfig {
    const safeMaxIterations = typeof config.maxIterations === "number" && Number.isFinite(config.maxIterations)
        ? Math.max(1, Math.floor(config.maxIterations))
        : undefined;

    return {
        ...config,
        members: sanitizeMembers(config.members),
        maxIterations: safeMaxIterations,
        interaction: getSquadInteractionConfig(config),
    };
}
