import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import type { AgentConfig } from "@/lib/core/Agent";
import { resolveAgentWorkspacePaths } from "@/lib/core/agentWorkspace";

const MEMORY_FILE = "MEMORY.md";
const DAILY_MEMORY_DIR = "memory";
const SEMANTIC_MEMORY_INDEX_RELATIVE_PATH = path.join(".runtime", "semantic-memory.json");
const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are", "was", "were",
    "be", "been", "being", "as", "at", "by", "that", "this", "it", "from", "we", "you", "i", "they", "he", "she",
    "them", "our", "your", "their", "can", "could", "should", "would", "may", "might", "must", "do", "does", "did",
]);

export type SemanticMemoryArea = "main" | "fragments" | "solutions";

export interface RecalledMemory {
    id: string;
    text: string;
    score: number;
    source: SemanticMemoryArea | "memory" | "daily";
    updatedAt: number;
}

interface SemanticMemoryEntry {
    id: string;
    text: string;
    area: SemanticMemoryArea;
    createdAt: number;
    updatedAt: number;
    checksum: string;
    tokens: string[];
}

interface SemanticMemoryIndex {
    version: 1;
    updatedAt: number;
    entries: SemanticMemoryEntry[];
}

export interface MemoryCandidate {
    text: string;
    area?: SemanticMemoryArea;
}

export interface MemoryIngestResult {
    total: number;
    added: number;
    merged: number;
    replaced: number;
    updated: number;
}

function tokenize(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[`*_~[\](){}<>#|]/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function normalizeSentence(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function splitCandidates(raw: string): string[] {
    return raw
        .split(/\r?\n+/)
        .map((line) => line.replace(/^[-*]\s+/, "").trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function toFrequencyVector(tokens: string[]): Map<string, number> {
    const vector = new Map<string, number>();
    for (const token of tokens) {
        vector.set(token, (vector.get(token) || 0) + 1);
    }
    return vector;
}

function cosineSimilarity(left: string[], right: string[]): number {
    if (left.length === 0 || right.length === 0) return 0;
    const leftVector = toFrequencyVector(left);
    const rightVector = toFrequencyVector(right);

    let dot = 0;
    for (const [token, count] of leftVector.entries()) {
        dot += count * (rightVector.get(token) || 0);
    }

    const leftMagnitude = Math.sqrt(Array.from(leftVector.values()).reduce((sum, value) => sum + value ** 2, 0));
    const rightMagnitude = Math.sqrt(Array.from(rightVector.values()).reduce((sum, value) => sum + value ** 2, 0));
    if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
    return dot / (leftMagnitude * rightMagnitude);
}

function checksum(value: string): string {
    return createHash("sha1").update(value).digest("hex");
}

async function readIfExists(filePath: string): Promise<string> {
    try {
        return await fs.readFile(filePath, "utf-8");
    } catch {
        return "";
    }
}

async function readDailyMemoryTail(dailyDir: string, maxFiles = 5): Promise<string> {
    try {
        const entries = await fs.readdir(dailyDir, { withFileTypes: true });
        const files = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) => entry.name)
            .sort((left, right) => right.localeCompare(left))
            .slice(0, maxFiles);
        const chunks = await Promise.all(files.map((fileName) => readIfExists(path.join(dailyDir, fileName))));
        return chunks.join("\n");
    } catch {
        return "";
    }
}

function createEntry(candidate: MemoryCandidate, now: number): SemanticMemoryEntry {
    const text = normalizeSentence(candidate.text);
    const area = candidate.area || "fragments";
    const key = `${area}:${text}`;
    return {
        id: checksum(key).slice(0, 20),
        text,
        area,
        createdAt: now,
        updatedAt: now,
        checksum: checksum(text),
        tokens: tokenize(text),
    };
}

function sanitizeIndex(raw: unknown): SemanticMemoryIndex {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { version: 1, updatedAt: Date.now(), entries: [] };
    }
    const source = raw as Record<string, unknown>;
    const entriesRaw = Array.isArray(source.entries) ? source.entries : [];
    const entries: SemanticMemoryEntry[] = [];

    for (const candidate of entriesRaw) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const record = candidate as Record<string, unknown>;
        const text = typeof record.text === "string" ? normalizeSentence(record.text) : "";
        if (!text) continue;
        const area = record.area === "main" || record.area === "fragments" || record.area === "solutions"
            ? record.area
            : "fragments";
        const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
            ? Math.floor(record.createdAt)
            : Date.now();
        const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
            ? Math.floor(record.updatedAt)
            : createdAt;
        entries.push({
            id: typeof record.id === "string" && record.id.trim().length > 0
                ? record.id.trim()
                : checksum(`${area}:${text}`).slice(0, 20),
            text,
            area,
            createdAt,
            updatedAt,
            checksum: typeof record.checksum === "string" && record.checksum.trim().length > 0
                ? record.checksum.trim()
                : checksum(text),
            tokens: Array.isArray(record.tokens)
                ? record.tokens.filter((token): token is string => typeof token === "string")
                : tokenize(text),
        });
    }

    return {
        version: 1,
        updatedAt: typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
            ? Math.floor(source.updatedAt)
            : Date.now(),
        entries,
    };
}

async function loadSemanticIndex(agent: AgentConfig): Promise<SemanticMemoryIndex> {
    const workspace = resolveAgentWorkspacePaths(agent);
    const indexPath = path.join(workspace.rootAbsolutePath, SEMANTIC_MEMORY_INDEX_RELATIVE_PATH);
    try {
        const raw = await fs.readFile(indexPath, "utf-8");
        return sanitizeIndex(JSON.parse(raw));
    } catch {
        return { version: 1, updatedAt: Date.now(), entries: [] };
    }
}

async function saveSemanticIndex(agent: AgentConfig, index: SemanticMemoryIndex): Promise<void> {
    const workspace = resolveAgentWorkspacePaths(agent);
    const indexPath = path.join(workspace.rootAbsolutePath, SEMANTIC_MEMORY_INDEX_RELATIVE_PATH);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

async function bootstrapLegacyMemoriesIntoIndex(agent: AgentConfig, index: SemanticMemoryIndex): Promise<SemanticMemoryIndex> {
    if (index.entries.length > 0) return index;

    const workspace = resolveAgentWorkspacePaths(agent);
    const memoryPath = path.join(workspace.rootAbsolutePath, MEMORY_FILE);
    const dailyDir = path.join(workspace.rootAbsolutePath, DAILY_MEMORY_DIR);

    const [memoryRaw, dailyRaw] = await Promise.all([
        readIfExists(memoryPath),
        readDailyMemoryTail(dailyDir),
    ]);

    const seedCandidates: MemoryCandidate[] = [
        ...splitCandidates(memoryRaw).map((text) => ({ text, area: "main" as const })),
        ...splitCandidates(dailyRaw).map((text) => ({ text, area: "fragments" as const })),
    ].slice(0, 400);

    const seeded = await ingestAgentMemoryCandidates(agent, seedCandidates, {
        index,
        maxEntries: 800,
    });
    return seeded.index;
}

function pruneEntries(entries: SemanticMemoryEntry[], maxEntries: number): SemanticMemoryEntry[] {
    if (entries.length <= maxEntries) return entries;
    return [...entries]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, maxEntries);
}

function findBestEntryMatch(
    entries: SemanticMemoryEntry[],
    candidateTokens: string[],
    area: SemanticMemoryArea,
): { entry: SemanticMemoryEntry; score: number } | null {
    let best: { entry: SemanticMemoryEntry; score: number } | null = null;
    for (const entry of entries) {
        if (entry.area !== area) continue;
        const score = cosineSimilarity(candidateTokens, entry.tokens);
        if (!best || score > best.score) {
            best = { entry, score };
        }
    }
    return best;
}

interface IngestOptions {
    index?: SemanticMemoryIndex;
    maxEntries?: number;
}

export async function ingestAgentMemoryCandidates(
    agent: AgentConfig,
    candidates: MemoryCandidate[],
    options?: IngestOptions,
): Promise<{ result: MemoryIngestResult; index: SemanticMemoryIndex }> {
    const now = Date.now();
    const maxEntries = Math.max(120, Math.min(2_000, Math.floor(options?.maxEntries || 1_000)));
    const index = options?.index || await loadSemanticIndex(agent);
    const result: MemoryIngestResult = {
        total: 0,
        added: 0,
        merged: 0,
        replaced: 0,
        updated: 0,
    };

    for (const rawCandidate of candidates) {
        const text = normalizeSentence(rawCandidate.text || "");
        if (!text || text.length < 10) continue;
        const area = rawCandidate.area || "fragments";
        const candidateTokens = tokenize(text);
        if (candidateTokens.length < 3) continue;

        result.total += 1;
        const bestMatch = findBestEntryMatch(index.entries, candidateTokens, area);
        if (!bestMatch) {
            index.entries.push(createEntry({ text, area }, now));
            result.added += 1;
            continue;
        }

        if (bestMatch.score >= 0.92) {
            const shouldReplace = text.length > (bestMatch.entry.text.length * 1.15);
            if (shouldReplace) {
                bestMatch.entry.text = text;
                bestMatch.entry.tokens = candidateTokens;
                bestMatch.entry.checksum = checksum(text);
                bestMatch.entry.updatedAt = now;
                result.replaced += 1;
            } else {
                bestMatch.entry.updatedAt = now;
                result.updated += 1;
            }
            continue;
        }

        if (bestMatch.score >= 0.72) {
            if (!bestMatch.entry.text.includes(text) && !text.includes(bestMatch.entry.text)) {
                const mergedText = `${bestMatch.entry.text}; ${text}`;
                bestMatch.entry.text = mergedText.length <= 360 ? mergedText : text;
                bestMatch.entry.tokens = tokenize(bestMatch.entry.text);
                bestMatch.entry.checksum = checksum(bestMatch.entry.text);
            }
            bestMatch.entry.updatedAt = now;
            result.merged += 1;
            continue;
        }

        index.entries.push(createEntry({ text, area }, now));
        result.added += 1;
    }

    index.entries = pruneEntries(index.entries, maxEntries);
    index.updatedAt = now;
    await saveSemanticIndex(agent, index);
    return { result, index };
}

export function extractMemoryCandidatesFromTurn(prompt: string, response: string): MemoryCandidate[] {
    const joined = `${prompt}\n${response}`;
    const lines = joined
        .split(/\r?\n+/)
        .flatMap((line) => line.split(/[.!?]+/))
        .map((line) => normalizeSentence(line))
        .filter((line) => line.length >= 18);

    const out: MemoryCandidate[] = [];
    const seen = new Set<string>();
    const durablePattern = /\b(prefer|need|must|always|never|constraint|priority|remember|avoid|required|important)\b/i;
    const solutionPattern = /\b(fix|resolved|solution|implemented|added|updated|patched|refactor|tests?)\b/i;

    for (const line of lines) {
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        if (durablePattern.test(line)) {
            out.push({ text: line, area: "main" });
            continue;
        }
        if (solutionPattern.test(line)) {
            out.push({ text: line, area: "solutions" });
            continue;
        }
        out.push({ text: line, area: "fragments" });
        if (out.length >= 20) break;
    }

    return out;
}

export async function recallAgentMemories(
    agent: AgentConfig,
    query: string,
    options?: { limit?: number; minScore?: number; areas?: SemanticMemoryArea[] },
): Promise<RecalledMemory[]> {
    const limit = Math.max(1, Math.min(20, Math.floor(options?.limit ?? 6)));
    const minScore = typeof options?.minScore === "number" ? options.minScore : 0.12;
    const areas = new Set(options?.areas || ["main", "fragments", "solutions"]);
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const loaded = await loadSemanticIndex(agent);
    const index = await bootstrapLegacyMemoriesIntoIndex(agent, loaded);
    if (index.entries.length === 0) return [];

    const scored = index.entries
        .filter((entry) => areas.has(entry.area))
        .map((entry) => ({
            id: entry.id,
            text: entry.text,
            score: cosineSimilarity(queryTokens, entry.tokens),
            source: entry.area,
            updatedAt: entry.updatedAt,
        }))
        .filter((entry) => entry.score >= minScore)
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return right.updatedAt - left.updatedAt;
        })
        .slice(0, limit);

    return scored;
}

export function buildMemoryRecallPrompt(memories: RecalledMemory[]): string {
    if (memories.length === 0) return "";
    const lines = memories.map((item, index) => (
        `${index + 1}. [${item.source}] ${item.text}`
    ));
    return [
        "### Recalled Memories",
        "Use these as strong prior context when they directly apply.",
        ...lines,
    ].join("\n");
}
