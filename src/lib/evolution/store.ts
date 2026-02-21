import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import type { AgentConfig } from "@/lib/core/Agent";
import { getAgentWorkspaceKey, resolveAgentWorkspacePaths } from "@/lib/core/agentWorkspace";
import type { Message } from "@/lib/core/types";
import type {
    EvolutionProfile,
    EvolutionRunLogEntry,
    EvolutionRunType,
    EvolutionStatus,
    NormalizedAgentEvolutionConfig,
} from "@/lib/evolution/types";
import {
    extractMemoryCandidatesFromTurn,
    ingestAgentMemoryCandidates,
    recallAgentMemories,
    type MemoryCandidate,
} from "@/lib/runtime/services/memoryRecallService";

const PROFILE_FILENAME = "profile.json";
const SOUL_FILENAME = "SOUL.md";
const MEMORY_FILENAME = "MEMORY.md";
const MEMORY_DAILY_DIRNAME = "memory";
const SKILLS_DIRNAME = "skills";
const SKILL_INDEX_FILENAME = "SKILL_INDEX.md";
const PRE_COMPACTION_COOLDOWN_MS = 30 * 60_000;

interface EvolutionPaths {
    rootDir: string;
    profilePath: string;
    soulPath: string;
    memoryPath: string;
    dailyMemoryDir: string;
    skillsDir: string;
    skillIndexPath: string;
}

interface RecordEvolutionTurnInput {
    agent: AgentConfig;
    config: NormalizedAgentEvolutionConfig;
    runType: EvolutionRunType;
    prompt: string;
    response: string;
}

function getPaths(agent: AgentConfig): EvolutionPaths {
    const { rootAbsolutePath } = resolveAgentWorkspacePaths(agent);
    return {
        rootDir: rootAbsolutePath,
        profilePath: path.join(rootAbsolutePath, PROFILE_FILENAME),
        soulPath: path.join(rootAbsolutePath, SOUL_FILENAME),
        memoryPath: path.join(rootAbsolutePath, MEMORY_FILENAME),
        dailyMemoryDir: path.join(rootAbsolutePath, MEMORY_DAILY_DIRNAME),
        skillsDir: path.join(rootAbsolutePath, SKILLS_DIRNAME),
        skillIndexPath: path.join(rootAbsolutePath, SKILLS_DIRNAME, SKILL_INDEX_FILENAME),
    };
}

function sha1Hex(value: string): string {
    return createHash("sha1").update(value).digest("hex");
}

function formatDateKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatTimeLabel(timestamp: number): string {
    const date = new Date(timestamp);
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${hour}:${minute}`;
}

function formatCompactTimestamp(timestamp: number): string {
    return new Date(timestamp).toISOString().replace("T", " ").replace("Z", " UTC");
}

function singleLine(value: string, maxChars = 220): string {
    const collapsed = (value || "").replace(/\s+/g, " ").trim();
    if (!collapsed) return "";
    if (collapsed.length <= maxChars) return collapsed;
    return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

function normalizeKey(value: string): string {
    return value
        .toLowerCase()
        .replace(/[`*_~[\](){}<>#|]/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function tailPreview(text: string, maxLines: number, maxChars: number): string {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
    const tail = lines.slice(-maxLines).join("\n");
    if (!tail) return "";
    if (tail.length <= maxChars) return tail;
    return tail.slice(tail.length - maxChars);
}

async function ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
}

async function readText(filePath: string): Promise<string> {
    try {
        return await fs.readFile(filePath, "utf-8");
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === "ENOENT") return "";
        throw error;
    }
}

async function writeText(filePath: string, content: string): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, "utf-8");
}

async function appendText(filePath: string, content: string): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, content, "utf-8");
}

function getDailyMemoryPath(paths: EvolutionPaths, timestamp: number): string {
    return path.join(paths.dailyMemoryDir, `${formatDateKey(timestamp)}.md`);
}

function buildDefaultProfile(agent: AgentConfig, timestamp: number): EvolutionProfile {
    const fallbackId = getAgentWorkspaceKey(agent);
    const agentId = String(agent.id || fallbackId);
    const agentName = String(agent.name || fallbackId);
    return {
        agentId,
        agentName,
        createdAt: timestamp,
        updatedAt: timestamp,
        level: 1,
        xp: 0,
        totalRuns: 0,
        totalAutonomyRuns: 0,
        mood: "curious",
        selfSummary: "I am an evolving agent. I improve through focused iterations.",
        recentRuns: [],
    };
}

function computeMood(runType: EvolutionRunType, response: string): EvolutionProfile["mood"] {
    if (runType === "autonomy") return "curious";
    if (response.length > 900) return "focused";
    if (response.length > 160) return "playful";
    return "sleepy";
}

function computeLevel(xp: number): number {
    return Math.max(1, 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 25)));
}

function sanitizeRunLogEntries(value: unknown): EvolutionRunLogEntry[] {
    if (!Array.isArray(value)) return [];
    const entries: EvolutionRunLogEntry[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const type = record.type === "autonomy" ? "autonomy" : record.type === "user" ? "user" : null;
        const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
            ? Math.floor(record.timestamp)
            : null;
        if (!type || !timestamp) continue;
        const id = typeof record.id === "string" && record.id.trim().length > 0
            ? record.id.trim()
            : `${type}-${timestamp}`;
        const summary = singleLine(typeof record.summary === "string" ? record.summary : "", 220);
        entries.push({
            id,
            type,
            timestamp,
            summary: summary || `${type === "autonomy" ? "Autonomy" : "User"} run at ${formatCompactTimestamp(timestamp)}.`,
        });
    }
    return entries.slice(0, 24);
}

function sanitizeProfile(agent: AgentConfig, value: unknown): EvolutionProfile {
    const now = Date.now();
    const fallback = buildDefaultProfile(agent, now);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const source = value as Record<string, unknown>;
    const xp = typeof source.xp === "number" && Number.isFinite(source.xp) ? Math.max(0, Math.floor(source.xp)) : fallback.xp;
    const totalRuns = typeof source.totalRuns === "number" && Number.isFinite(source.totalRuns)
        ? Math.max(0, Math.floor(source.totalRuns))
        : fallback.totalRuns;
    const totalAutonomyRuns = typeof source.totalAutonomyRuns === "number" && Number.isFinite(source.totalAutonomyRuns)
        ? Math.max(0, Math.floor(source.totalAutonomyRuns))
        : fallback.totalAutonomyRuns;
    const mood = source.mood === "sleepy" || source.mood === "curious" || source.mood === "focused" || source.mood === "playful"
        ? source.mood
        : fallback.mood;
    const selfSummary = singleLine(typeof source.selfSummary === "string" ? source.selfSummary : fallback.selfSummary, 600) || fallback.selfSummary;
    const createdAt = typeof source.createdAt === "number" && Number.isFinite(source.createdAt)
        ? Math.floor(source.createdAt)
        : fallback.createdAt;
    const updatedAt = typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
        ? Math.floor(source.updatedAt)
        : fallback.updatedAt;

    const profile: EvolutionProfile = {
        agentId: typeof source.agentId === "string" && source.agentId.trim().length > 0 ? source.agentId.trim() : fallback.agentId,
        agentName: typeof source.agentName === "string" && source.agentName.trim().length > 0 ? source.agentName.trim() : fallback.agentName,
        createdAt,
        updatedAt,
        level: typeof source.level === "number" && Number.isFinite(source.level)
            ? Math.max(1, Math.floor(source.level))
            : computeLevel(xp),
        xp,
        totalRuns,
        totalAutonomyRuns,
        mood,
        selfSummary,
        recentRuns: sanitizeRunLogEntries(source.recentRuns),
    };

    if (typeof source.lastRunAt === "number" && Number.isFinite(source.lastRunAt)) {
        profile.lastRunAt = Math.floor(source.lastRunAt);
    }
    if (typeof source.lastAutonomyRunAt === "number" && Number.isFinite(source.lastAutonomyRunAt)) {
        profile.lastAutonomyRunAt = Math.floor(source.lastAutonomyRunAt);
    }
    if (typeof source.nextScheduledRunAt === "number" && Number.isFinite(source.nextScheduledRunAt)) {
        profile.nextScheduledRunAt = Math.floor(source.nextScheduledRunAt);
    }
    if (typeof source.lastCompactionAt === "number" && Number.isFinite(source.lastCompactionAt)) {
        profile.lastCompactionAt = Math.floor(source.lastCompactionAt);
    }
    if (typeof source.lastCompactionDigest === "string" && source.lastCompactionDigest.trim().length > 0) {
        profile.lastCompactionDigest = source.lastCompactionDigest.trim().slice(0, 96);
    }
    return profile;
}

function buildDefaultSoul(agent: AgentConfig): string {
    const name = singleLine(String(agent.name || "Cat"), 80) || "Cat";
    const role = singleLine(String(agent.role || "Assistant"), 80) || "Assistant";
    const purpose = singleLine((agent.description || "").trim(), 240) || "Help effectively and improve incrementally.";
    return [
        "# SOUL",
        "",
        "## Identity",
        `- Name: ${name}`,
        `- Role: ${role}`,
        `- Purpose: ${purpose}`,
        "",
        "## Reflection Log",
        "- Initial soul created.",
        "",
    ].join("\n");
}

function buildDefaultMemory(): string {
    return [
        "# Persistent Memory",
        "",
        "Durable preferences, constraints, and long-term commitments.",
        "",
    ].join("\n");
}

function buildDefaultSkillIndex(): string {
    return [
        "# Skill Index",
        "",
        "Generated skill snapshots.",
        "",
    ].join("\n");
}

async function ensureEvolutionFiles(agent: AgentConfig): Promise<EvolutionPaths> {
    const paths = getPaths(agent);
    await ensureDir(paths.rootDir);
    await ensureDir(paths.dailyMemoryDir);
    await ensureDir(paths.skillsDir);

    const profileRaw = await readText(paths.profilePath);
    if (!profileRaw.trim()) {
        await writeText(paths.profilePath, JSON.stringify(buildDefaultProfile(agent, Date.now()), null, 2));
    }

    const soulRaw = await readText(paths.soulPath);
    if (!soulRaw.trim()) {
        await writeText(paths.soulPath, buildDefaultSoul(agent));
    }

    const memoryRaw = await readText(paths.memoryPath);
    if (!memoryRaw.trim()) {
        await writeText(paths.memoryPath, buildDefaultMemory());
    }

    const skillIndexRaw = await readText(paths.skillIndexPath);
    if (!skillIndexRaw.trim()) {
        await writeText(paths.skillIndexPath, buildDefaultSkillIndex());
    }

    return paths;
}

function selectLongTermMemoryLines(candidates: MemoryCandidate[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (candidate.area === "fragments") continue;
        const normalized = singleLine(candidate.text || "", 180);
        if (!normalized) continue;
        const key = normalizeKey(normalized);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
        if (out.length >= 10) break;
    }
    return out;
}

function shouldCaptureSkillSnapshot(prompt: string, response: string): boolean {
    if (response.includes("```") && response.length > 220) return true;
    const promptIntent = /\b(how to|workflow|steps?|guide|implement|configure|debug|fix|setup|create|build)\b/i.test(prompt);
    const structured = /\n\s*(?:\d+\.|-)\s+\S+/m.test(response);
    const procedural = /\b(step|first|then|next|finally|command|script|config|workflow)\b/i.test(response);
    return promptIntent && structured && procedural && response.length > 280;
}

function deriveSkillTitle(prompt: string, response: string): string {
    const heading = response
        .split(/\r?\n/)
        .map((line) => line.replace(/^#+\s*/, "").trim())
        .find((line) => line.length >= 6 && !line.startsWith("```"));
    if (heading) return singleLine(heading, 72);
    const fromPrompt = singleLine(prompt, 72);
    if (fromPrompt) return fromPrompt;
    return "Learned Skill";
}

function slugForFile(value: string): string {
    const slug = value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return slug.slice(0, 40) || "skill";
}

async function appendDailyEntry(paths: EvolutionPaths, timestamp: number, entry: string): Promise<void> {
    const dailyPath = getDailyMemoryPath(paths, timestamp);
    const existing = await readText(dailyPath);
    if (!existing.trim()) {
        await writeText(dailyPath, `# Daily Memory ${formatDateKey(timestamp)}\n\n`);
    }
    await appendText(dailyPath, `- [${formatTimeLabel(timestamp)}] ${entry}\n`);
}

async function appendLongTermEntries(paths: EvolutionPaths, timestamp: number, entries: string[]): Promise<void> {
    if (entries.length === 0) return;
    const raw = await readText(paths.memoryPath);
    const base = raw.trim() ? raw : buildDefaultMemory();
    const lines = base.split(/\r?\n/);
    const existingKeys = new Set<string>();
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("-")) continue;
        const key = normalizeKey(trimmed.replace(/^\-\s*/, ""));
        if (key) existingKeys.add(key);
    }
    const accepted: string[] = [];
    for (const entry of entries) {
        const normalized = singleLine(entry, 180);
        if (!normalized) continue;
        const key = normalizeKey(normalized);
        if (!key || existingKeys.has(key)) continue;
        existingKeys.add(key);
        accepted.push(normalized);
    }
    if (accepted.length === 0) return;

    const dateHeader = `## ${formatDateKey(timestamp)} Updates`;
    const existingHeaderIndex = lines.findIndex((line) => line.trim() === dateHeader);
    if (existingHeaderIndex < 0) {
        const output = [
            base.trimEnd(),
            "",
            dateHeader,
            ...accepted.map((entry) => `- ${entry}`),
            "",
        ].join("\n");
        await writeText(paths.memoryPath, output);
        return;
    }

    let sectionEnd = lines.length;
    for (let i = existingHeaderIndex + 1; i < lines.length; i += 1) {
        if (lines[i].trim().startsWith("## ")) {
            sectionEnd = i;
            break;
        }
    }
    const outputLines = [
        ...lines.slice(0, sectionEnd),
        ...accepted.map((entry) => `- ${entry}`),
        ...lines.slice(sectionEnd),
    ];
    await writeText(paths.memoryPath, `${outputLines.join("\n").trimEnd()}\n`);
}

async function appendSoulReflection(paths: EvolutionPaths, timestamp: number, prompt: string, response: string): Promise<void> {
    const soulRaw = await readText(paths.soulPath);
    const source = soulRaw.trim() ? soulRaw : buildDefaultSoul({} as AgentConfig);
    const lines = source.split(/\r?\n/);
    const reflectionHeader = "## Reflection Log";
    let headerIndex = lines.findIndex((line) => line.trim() === reflectionHeader);
    if (headerIndex < 0) {
        lines.push("", reflectionHeader);
        headerIndex = lines.length - 1;
    }

    const focus = singleLine(prompt, 96) || "(routine run)";
    const insight = singleLine(response, 124) || "Run completed.";
    const nextLine = `- ${formatDateKey(timestamp)} ${formatTimeLabel(timestamp)} | Focus: ${focus} | Insight: ${insight}`;
    const signature = normalizeKey(`${focus}|${insight}`);

    const existing = lines
        .slice(headerIndex + 1)
        .filter((line) => line.trim().startsWith("-"))
        .map((line) => line.trim());
    const existingSignatures = new Set(existing.map((line) => {
        const match = /^\-\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\|\s+Focus:\s*(.*?)\s+\|\s+Insight:\s*(.*)$/i.exec(line);
        if (!match) return normalizeKey(line);
        return normalizeKey(`${match[1]}|${match[2]}`);
    }));
    if (signature && existingSignatures.has(signature)) return;

    const merged = [...existing, nextLine].slice(-32);
    const prefix = lines.slice(0, headerIndex + 1);
    const rebuilt = [...prefix, ...merged, ""].join("\n");
    await writeText(paths.soulPath, rebuilt);
}

async function createSkillSnapshot(
    paths: EvolutionPaths,
    timestamp: number,
    title: string,
    prompt: string,
    response: string,
): Promise<string | null> {
    const digest = sha1Hex(`${title}\n${prompt}\n${response}`).slice(0, 16);
    const skillIndexRaw = await readText(paths.skillIndexPath);
    if (new RegExp(`\\[sha1:${digest}\\]`, "i").test(skillIndexRaw)) {
        return null;
    }

    const stamp = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
    const filename = `${stamp}-${slugForFile(title)}.md`;
    const filePath = path.join(paths.skillsDir, filename);
    const snapshot = [
        `# ${title}`,
        "",
        "## Trigger",
        "",
        prompt.trim() || "(empty prompt)",
        "",
        "## Learned Output",
        "",
        response.trim() || "(empty response)",
        "",
        `Fingerprint: sha1:${digest}`,
        "",
        `Generated: ${formatCompactTimestamp(timestamp)}`,
        "",
    ].join("\n");
    await writeText(filePath, snapshot);

    const indexBase = skillIndexRaw.trim() ? skillIndexRaw.trimEnd() : buildDefaultSkillIndex().trimEnd();
    const nextIndex = `${indexBase}\n- ${formatCompactTimestamp(timestamp)} - ${title} (${filename}) [sha1:${digest}]\n`;
    await writeText(paths.skillIndexPath, nextIndex);
    return filename;
}

function summarizeRun(runType: EvolutionRunType, prompt: string, response: string): string {
    const topic = singleLine(prompt, 96);
    const empty = response.trim().length === 0;
    if (!topic) return runType === "autonomy"
        ? (empty ? "Autonomy run completed (empty output)." : "Autonomy run completed.")
        : (empty ? "User turn completed (empty output)." : "User turn completed.");
    if (runType === "autonomy") {
        return empty ? `Autonomy run on "${topic}" (empty output).` : `Autonomy run on "${topic}".`;
    }
    return empty ? `User turn on "${topic}" (empty output).` : `User turn on "${topic}".`;
}

function buildSelfSummary(profile: EvolutionProfile): string {
    const latest = profile.recentRuns[0];
    const latestText = latest
        ? `Latest run: ${latest.type} at ${formatCompactTimestamp(latest.timestamp)}.`
        : "No runs yet.";
    return `Level ${profile.level}, mood ${profile.mood}, total runs ${profile.totalRuns}, autonomy runs ${profile.totalAutonomyRuns}. ${latestText}`;
}

function isConversationMessage(message: Message): boolean {
    return message.role === "user" || message.role === "assistant";
}

export async function readEvolutionProfile(agent: AgentConfig): Promise<EvolutionProfile> {
    const paths = await ensureEvolutionFiles(agent);
    const raw = await readText(paths.profilePath);
    if (!raw.trim()) {
        const fallback = buildDefaultProfile(agent, Date.now());
        await writeText(paths.profilePath, JSON.stringify(fallback, null, 2));
        return fallback;
    }
    try {
        return sanitizeProfile(agent, JSON.parse(raw));
    } catch {
        const fallback = buildDefaultProfile(agent, Date.now());
        await writeText(paths.profilePath, JSON.stringify(fallback, null, 2));
        return fallback;
    }
}

export async function writeEvolutionProfile(agent: AgentConfig, profile: EvolutionProfile): Promise<void> {
    const paths = await ensureEvolutionFiles(agent);
    const sanitized = sanitizeProfile(agent, profile);
    await writeText(paths.profilePath, JSON.stringify(sanitized, null, 2));
}

export async function preCompactionMemoryFlush(
    agent: AgentConfig,
    config: NormalizedAgentEvolutionConfig,
    history: Message[],
): Promise<boolean> {
    if (!config.enabled || !config.memoryEnabled) return false;
    if (!Array.isArray(history) || history.length === 0) return false;

    const renderable = history
        .filter((message): message is Message => Boolean(message) && isConversationMessage(message))
        .slice(-30);
    if (renderable.length < 10) return false;

    const merged = renderable
        .map((message) => `${message.role.toUpperCase()}: ${message.content || ""}`)
        .join("\n");
    if (merged.trim().length < 2400) return false;

    const now = Date.now();
    const paths = await ensureEvolutionFiles(agent);
    const profile = await readEvolutionProfile(agent);
    const digest = sha1Hex(merged).slice(0, 20);

    if (
        profile.lastCompactionDigest === digest
        && typeof profile.lastCompactionAt === "number"
        && (now - profile.lastCompactionAt) < PRE_COMPACTION_COOLDOWN_MS
    ) {
        return false;
    }

    await appendDailyEntry(paths, now, `PRE-COMPACTION FLUSH | ${singleLine(merged, 320)}`);
    const candidates = extractMemoryCandidatesFromTurn(merged, merged);
    await ingestAgentMemoryCandidates(agent, candidates);
    await appendLongTermEntries(paths, now, selectLongTermMemoryLines(candidates));
    await writeEvolutionProfile(agent, {
        ...profile,
        updatedAt: now,
        lastCompactionAt: now,
        lastCompactionDigest: digest,
    });
    return true;
}

export async function getEvolutionStatus(agent: AgentConfig): Promise<EvolutionStatus> {
    const paths = await ensureEvolutionFiles(agent);
    const profile = await readEvolutionProfile(agent);
    const soul = await readText(paths.soulPath);
    const memory = await readText(paths.memoryPath);
    const dailyPath = getDailyMemoryPath(paths, Date.now());
    const daily = await readText(dailyPath);

    let skillSnapshots: string[] = [];
    try {
        const entries = await fs.readdir(paths.skillsDir, { withFileTypes: true });
        skillSnapshots = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== SKILL_INDEX_FILENAME)
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a))
            .slice(0, 10);
    } catch {
        skillSnapshots = [];
    }

    return {
        profile,
        soulPreview: tailPreview(soul, 28, 2000),
        longTermMemoryPreview: tailPreview(memory, 12, 1200),
        dailyMemoryPreview: tailPreview(daily, 10, 1000),
        skillSnapshots,
    };
}

export async function buildEvolutionSystemContext(
    agent: AgentConfig,
    config: NormalizedAgentEvolutionConfig,
): Promise<string> {
    if (!config.enabled) return "";
    const status = await getEvolutionStatus(agent);
    const semanticRecall = config.memoryEnabled
        ? await recallAgentMemories(agent, `${status.profile.selfSummary}\n${status.longTermMemoryPreview}`, {
            limit: 5,
            minScore: 0.1,
        })
        : [];
    const workspace = resolveAgentWorkspacePaths(agent);
    const skillList = status.skillSnapshots.length > 0
        ? status.skillSnapshots.map((name, index) => `${index + 1}. ${name}`).join("\n")
        : "(no skill snapshots yet)";
    const semanticList = semanticRecall.length > 0
        ? semanticRecall.map((item, index) => `${index + 1}. [${item.source}] ${item.text}`).join("\n")
        : "(no semantic memory recall yet)";
    const lines = [
        "## SELF-EVOLVING CAT MODE",
        "Treat this state as persistent memory and self-awareness context.",
        "",
        "### Self Awareness",
        `- Level: ${status.profile.level}`,
        `- XP: ${status.profile.xp}`,
        `- Mood: ${status.profile.mood}`,
        `- Total runs: ${status.profile.totalRuns}`,
        `- Autonomy runs: ${status.profile.totalAutonomyRuns}`,
        `- Self summary: ${status.profile.selfSummary}`,
        "",
        "### Workspace Contract",
        `- Workspace root: ${workspace.rootRelativePath}`,
        `- Artifacts directory: ${workspace.artifactsRelativePath}`,
        "- Keep filesystem and shell operations scoped to this workspace.",
        "",
        "### Artifact Rules",
        "- SOUL.md: identity + concise reflections.",
        "- MEMORY.md: durable long-term statements only.",
        "- memory/YYYY-MM-DD.md: chronological run journal.",
        "- skills/: reusable procedural snapshots.",
        "",
        "### Soul (SOUL.md)",
        status.soulPreview || "(no soul yet)",
        "",
        "### Persistent Memory (MEMORY.md tail)",
        status.longTermMemoryPreview || "(no long-term memory yet)",
        "",
        "### Daily Memory (today tail)",
        status.dailyMemoryPreview || "(no daily memory yet)",
        "",
        "### Skill Snapshots (recent)",
        skillList,
        "",
        "### Semantic Memory Recall",
        semanticList,
        "",
        "Use this state to adapt behavior incrementally.",
    ];
    const context = lines.join("\n").trim();
    return context.length > 4500 ? `${context.slice(0, 4499).trimEnd()}…` : context;
}

export async function initializeEvolutionSchedule(agent: AgentConfig, everyMinutes: number): Promise<EvolutionProfile> {
    const now = Date.now();
    const current = await readEvolutionProfile(agent);
    if (typeof current.nextScheduledRunAt === "number" && Number.isFinite(current.nextScheduledRunAt)) {
        return current;
    }
    const safeMinutes = Math.max(1, Math.floor(everyMinutes));
    const updated: EvolutionProfile = {
        ...current,
        updatedAt: now,
        nextScheduledRunAt: now + safeMinutes * 60_000,
    };
    await writeEvolutionProfile(agent, updated);
    return updated;
}

export async function recordEvolutionTurn(input: RecordEvolutionTurnInput): Promise<EvolutionStatus> {
    const now = Date.now();
    const { agent, config, runType, prompt, response } = input;
    if (!config.enabled) return getEvolutionStatus(agent);

    const paths = await ensureEvolutionFiles(agent);
    const profile = await readEvolutionProfile(agent);

    const xpDelta = (runType === "autonomy" ? 12 : 6) + Math.min(12, Math.floor(Math.max(response.length, 0) / 240));
    const xp = profile.xp + xpDelta;
    const totalRuns = profile.totalRuns + 1;
    const totalAutonomyRuns = profile.totalAutonomyRuns + (runType === "autonomy" ? 1 : 0);
    const runEntry: EvolutionRunLogEntry = {
        id: `${runType}-${now}`,
        type: runType,
        timestamp: now,
        summary: summarizeRun(runType, prompt, response),
    };
    const recentRuns = [runEntry, ...profile.recentRuns].slice(0, 24);

    const updated: EvolutionProfile = {
        ...profile,
        agentName: String(agent.name || profile.agentName),
        updatedAt: now,
        xp,
        level: computeLevel(xp),
        totalRuns,
        totalAutonomyRuns,
        mood: computeMood(runType, response),
        lastRunAt: now,
        lastAutonomyRunAt: runType === "autonomy" ? now : profile.lastAutonomyRunAt,
        nextScheduledRunAt: config.schedule.enabled
            ? now + Math.max(1, Math.floor(config.schedule.everyMinutes)) * 60_000
            : undefined,
        recentRuns,
        selfSummary: profile.selfSummary,
    };

    const hooksEnabled = config.enabled && config.hooksEnabled;
    if (hooksEnabled && config.hooks.includes("memory_capture") && config.memoryEnabled) {
        await appendDailyEntry(
            paths,
            now,
            `${runType.toUpperCase()} | prompt: ${singleLine(prompt, 140) || "(empty)"} | response: ${singleLine(response, 180) || "(empty)"}`,
        );
        const candidates = extractMemoryCandidatesFromTurn(prompt, response);
        await ingestAgentMemoryCandidates(agent, candidates);
        await appendLongTermEntries(paths, now, selectLongTermMemoryLines(candidates));
    }

    if (hooksEnabled && config.hooks.includes("skill_snapshot") && config.skillSnapshotsEnabled) {
        if (shouldCaptureSkillSnapshot(prompt, response)) {
            await createSkillSnapshot(paths, now, deriveSkillTitle(prompt, response), prompt, response);
        }
    }

    if (hooksEnabled && config.hooks.includes("self_reflection") && config.selfAwarenessEnabled) {
        updated.selfSummary = buildSelfSummary(updated);
        await appendSoulReflection(paths, now, prompt, response);
    }

    await writeEvolutionProfile(agent, updated);
    return getEvolutionStatus(agent);
}
