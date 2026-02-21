export type EvolutionHookId = "memory_capture" | "skill_snapshot" | "self_reflection";

export type EvolutionRunType = "user" | "autonomy";

export interface AgentEvolutionScheduleConfig {
    enabled?: boolean;
    everyMinutes?: number;
    prompt?: string;
}

export interface AgentEvolutionConfig {
    enabled?: boolean;
    memoryEnabled?: boolean;
    skillSnapshotsEnabled?: boolean;
    selfAwarenessEnabled?: boolean;
    hooksEnabled?: boolean;
    hooks?: EvolutionHookId[];
    schedule?: AgentEvolutionScheduleConfig;
}

export interface NormalizedAgentEvolutionConfig {
    enabled: boolean;
    memoryEnabled: boolean;
    skillSnapshotsEnabled: boolean;
    selfAwarenessEnabled: boolean;
    hooksEnabled: boolean;
    hooks: EvolutionHookId[];
    schedule: {
        enabled: boolean;
        everyMinutes: number;
        prompt: string;
    };
}

export interface EvolutionRunLogEntry {
    id: string;
    type: EvolutionRunType;
    timestamp: number;
    summary: string;
}

export interface EvolutionProfile {
    agentId: string;
    agentName: string;
    createdAt: number;
    updatedAt: number;
    level: number;
    xp: number;
    totalRuns: number;
    totalAutonomyRuns: number;
    mood: "sleepy" | "curious" | "focused" | "playful";
    selfSummary: string;
    lastRunAt?: number;
    lastAutonomyRunAt?: number;
    nextScheduledRunAt?: number;
    lastCompactionAt?: number;
    lastCompactionDigest?: string;
    recentRuns: EvolutionRunLogEntry[];
}

export interface EvolutionStatus {
    profile: EvolutionProfile;
    soulPreview: string;
    longTermMemoryPreview: string;
    dailyMemoryPreview: string;
    skillSnapshots: string[];
}

export const DEFAULT_EVOLUTION_HOOKS: EvolutionHookId[] = [
    "memory_capture",
    "skill_snapshot",
    "self_reflection",
];

export const DEFAULT_EVOLUTION_SCHEDULE_PROMPT = "Reflect on your long-term memory, extract one durable insight, and propose one concrete improvement to your behavior.";

const EVOLUTION_HOOK_SET = new Set<EvolutionHookId>(DEFAULT_EVOLUTION_HOOKS);

const EVOLUTION_SCHEDULE_MIN_MINUTES = 1;
const EVOLUTION_SCHEDULE_MAX_MINUTES = 24 * 60;
const EVOLUTION_SCHEDULE_DEFAULT_MINUTES = 30;

function clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function sanitizeHookList(value: unknown): EvolutionHookId[] {
    if (!Array.isArray(value)) return [...DEFAULT_EVOLUTION_HOOKS];

    const out: EvolutionHookId[] = [];
    for (const candidate of value) {
        if (typeof candidate !== "string") continue;
        const normalized = candidate.trim() as EvolutionHookId;
        if (!EVOLUTION_HOOK_SET.has(normalized)) continue;
        if (out.includes(normalized)) continue;
        out.push(normalized);
    }

    return out.length > 0 ? out : [...DEFAULT_EVOLUTION_HOOKS];
}

export function normalizeEvolutionConfig(value: unknown): NormalizedAgentEvolutionConfig {
    const source = (value && typeof value === "object" && !Array.isArray(value))
        ? (value as Record<string, unknown>)
        : {};

    const scheduleSource = (source.schedule && typeof source.schedule === "object" && !Array.isArray(source.schedule))
        ? (source.schedule as Record<string, unknown>)
        : {};

    const requestedMinutes = typeof scheduleSource.everyMinutes === "number"
        ? Math.floor(scheduleSource.everyMinutes)
        : EVOLUTION_SCHEDULE_DEFAULT_MINUTES;

    const scheduleMinutes = clampNumber(
        Number.isFinite(requestedMinutes) ? requestedMinutes : EVOLUTION_SCHEDULE_DEFAULT_MINUTES,
        EVOLUTION_SCHEDULE_MIN_MINUTES,
        EVOLUTION_SCHEDULE_MAX_MINUTES,
    );

    const schedulePrompt = typeof scheduleSource.prompt === "string" && scheduleSource.prompt.trim().length > 0
        ? scheduleSource.prompt.trim()
        : DEFAULT_EVOLUTION_SCHEDULE_PROMPT;

    const normalized: NormalizedAgentEvolutionConfig = {
        enabled: source.enabled === true,
        memoryEnabled: source.memoryEnabled !== false,
        skillSnapshotsEnabled: source.skillSnapshotsEnabled !== false,
        selfAwarenessEnabled: source.selfAwarenessEnabled !== false,
        hooksEnabled: source.hooksEnabled !== false,
        hooks: sanitizeHookList(source.hooks),
        schedule: {
            enabled: scheduleSource.enabled === true,
            everyMinutes: scheduleMinutes,
            prompt: schedulePrompt,
        },
    };

    return normalized;
}

export function hasEvolutionEnabled(value: unknown): boolean {
    return normalizeEvolutionConfig(value).enabled;
}
