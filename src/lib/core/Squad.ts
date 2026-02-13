import { AgentConfig, AgentStyle } from "./Agent";
import { isKnownDeprecatedModel } from "../llm/modelCatalog";

export type SquadInteractionMode = "master_log" | "live_campaign";
export type SquadUserTurnPolicy = "on_demand" | "every_round";

export interface SquadInteractionConfig {
    mode: SquadInteractionMode;
    showMasterLog: boolean;
    showAgentMessagesInChat: boolean;
    includeDirectorMessagesInChat: boolean;
    userTurnPolicy: SquadUserTurnPolicy;
}

export interface SquadOrchestratorProfile {
    name: string;
    provider: string;
    model: string;
    style: AgentStyle;
    voiceId: string;
}

const MASTER_LOG_INTERACTION_DEFAULTS: SquadInteractionConfig = {
    mode: "master_log",
    showMasterLog: true,
    showAgentMessagesInChat: false,
    includeDirectorMessagesInChat: false,
    userTurnPolicy: "on_demand",
};

const LIVE_CAMPAIGN_INTERACTION_DEFAULTS: SquadInteractionConfig = {
    mode: "live_campaign",
    showMasterLog: false,
    showAgentMessagesInChat: true,
    includeDirectorMessagesInChat: true,
    userTurnPolicy: "every_round",
};

export const DEFAULT_SQUAD_INTERACTION = MASTER_LOG_INTERACTION_DEFAULTS;
export const DEFAULT_SQUAD_ORCHESTRATOR_PROFILE: SquadOrchestratorProfile = {
    name: "OR",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    style: "assistant",
    voiceId: "en-US-ChristopherNeural",
};

export interface SquadConfig {
    id?: string;
    name: string;
    goal?: string;
    context?: string;
    // Legacy alias retained for backward compatibility with existing local storage.
    mission?: string;
    members: string[];
    maxIterations?: number;
    orchestrator?: Partial<SquadOrchestratorProfile>;
    interaction?: Partial<SquadInteractionConfig>;
}

export interface SquadRunStep {
    iteration: number;
    directorDecision: DirectorDecision;
    workerAgentId?: string;
    workerAgentName?: string;
    workerInstruction?: string;
    workerOutput?: string;
    workerToolExecution?: {
        attempted: number;
        succeeded: number;
        failed: number;
        malformed: number;
        verifiedFileEffects: number;
        verifiedShellEffects: number;
    };
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
    workers: AgentConfig[];
    orchestrator: SquadOrchestratorProfile;
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

function sanitizeText(input: unknown): string {
    return typeof input === "string" ? input.trim() : "";
}

function normalizeStyle(input: unknown): AgentStyle | null {
    if (input === "assistant" || input === "character" || input === "expert" || input === "custom") {
        return input;
    }
    return null;
}

function sanitizeMembers(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const output: string[] = [];

    for (const entry of input) {
        if (typeof entry !== "string") continue;
        const value = entry.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        output.push(value);
    }

    return output;
}

export function getSquadGoal(config?: SquadConfig | null): string {
    const directGoal = sanitizeText(config?.goal);
    if (directGoal) return directGoal;
    return sanitizeText(config?.mission);
}

export function getSquadContext(config?: SquadConfig | null): string {
    return sanitizeText(config?.context);
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
        userTurnPolicy: normalizeTurnPolicy(source.userTurnPolicy) || modeDefaults.userTurnPolicy,
    };
}

export function normalizeSquadConfig(config: SquadConfig): SquadConfig {
    const legacyDirectorId = sanitizeText((config as { directorId?: unknown }).directorId);
    const normalizedMembers = sanitizeMembers(config.members);
    const effectiveMembers = normalizedMembers.length > 0
        ? normalizedMembers
        : (legacyDirectorId ? [legacyDirectorId] : []);

    const goal = getSquadGoal(config);
    const context = getSquadContext(config);
    const safeMaxIterations = typeof config.maxIterations === "number" && Number.isFinite(config.maxIterations)
        ? Math.max(1, Math.floor(config.maxIterations))
        : undefined;
    const orchestrator = config.orchestrator ?? {};
    const orchestratorProvider = sanitizeText(orchestrator.provider) || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.provider;
    const requestedOrchestratorModel = sanitizeText(orchestrator.model);
    const orchestratorModel = requestedOrchestratorModel
        && !isKnownDeprecatedModel(orchestratorProvider, requestedOrchestratorModel)
        ? requestedOrchestratorModel
        : DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.model;

    return {
        ...config,
        goal,
        mission: goal,
        context,
        members: effectiveMembers,
        maxIterations: safeMaxIterations,
        orchestrator: {
            name: sanitizeText(orchestrator.name) || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.name,
            provider: orchestratorProvider,
            model: orchestratorModel,
            style: normalizeStyle(orchestrator.style) || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.style,
            voiceId: sanitizeText(orchestrator.voiceId) || DEFAULT_SQUAD_ORCHESTRATOR_PROFILE.voiceId,
        },
        interaction: getSquadInteractionConfig(config),
    };
}
