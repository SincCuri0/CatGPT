import type { LLMMessage, LLMToolCall } from "@/lib/llm/types";

const TOOL_ERROR_PREFIX = "Error: Missing tool result";

const LONG_MESSAGE_TRIM_THRESHOLD_CHARS = 2_800;
const LONG_MESSAGE_HEAD_CHARS = 1_300;
const LONG_MESSAGE_TAIL_CHARS = 900;
const HARD_MESSAGE_MAX_CHARS = 8_000;

const SUMMARY_MAX_LINES = 14;

function clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function estimateTokenCount(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessageTokens(message: LLMMessage): number {
    const roleOverhead = 8;
    const toolOverhead = Array.isArray(message.toolCalls) ? message.toolCalls.length * 10 : 0;
    return roleOverhead + toolOverhead + estimateTokenCount(message.content || "");
}

export function estimateHistoryTokens(messages: LLMMessage[]): number {
    return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function toSingleLine(text: string, maxChars = 200): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function preserveHeadTail(text: string): string {
    if (text.length <= LONG_MESSAGE_TRIM_THRESHOLD_CHARS) return text;

    const head = text.slice(0, LONG_MESSAGE_HEAD_CHARS).trimEnd();
    const tail = text.slice(-LONG_MESSAGE_TAIL_CHARS).trimStart();
    const omittedChars = Math.max(0, text.length - head.length - tail.length);
    const marker = `\n\n[... trimmed middle (${omittedChars.toLocaleString()} chars) ...]\n\n`;
    const combined = `${head}${marker}${tail}`;
    if (combined.length <= HARD_MESSAGE_MAX_CHARS) return combined;
    return `${combined.slice(0, HARD_MESSAGE_MAX_CHARS - 1).trimEnd()}…`;
}

function normalizeHistoryMessage(message: LLMMessage): { message: LLMMessage; trimmed: boolean } {
    const content = message.content || "";
    const nextContent = preserveHeadTail(content);
    if (nextContent === content) {
        return { message, trimmed: false };
    }
    return {
        message: {
            ...message,
            content: nextContent,
        },
        trimmed: true,
    };
}

interface TurnSlice {
    startIndex: number;
    endIndex: number;
    tokenCost: number;
}

function splitTurns(messages: LLMMessage[]): TurnSlice[] {
    if (messages.length === 0) return [];

    const turns: TurnSlice[] = [];
    let currentStart = 0;
    let currentTokens = 0;

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const isUserBoundary = message.role === "user";
        if (index > currentStart && isUserBoundary) {
            turns.push({
                startIndex: currentStart,
                endIndex: index - 1,
                tokenCost: currentTokens,
            });
            currentStart = index;
            currentTokens = 0;
        }

        currentTokens += estimateMessageTokens(message);
    }

    turns.push({
        startIndex: currentStart,
        endIndex: messages.length - 1,
        tokenCost: currentTokens,
    });
    return turns;
}

function buildTurnSnippet(messages: LLMMessage[], turn: TurnSlice, maxChars = 220): string {
    const slice = messages.slice(turn.startIndex, turn.endIndex + 1);
    const userMessage = slice.find((message) => message.role === "user");
    const assistantMessage = [...slice].reverse().find((message) => message.role === "assistant");
    const userText = userMessage ? toSingleLine(userMessage.content, maxChars) : "(no user text)";
    const assistantText = assistantMessage ? toSingleLine(assistantMessage.content, maxChars) : "(no assistant text)";
    return `U: ${userText} | A: ${assistantText}`;
}

function chunkTurnsByTokenBudget(turns: TurnSlice[], targetChunkTokens: number): TurnSlice[][] {
    if (turns.length === 0) return [];
    const chunks: TurnSlice[][] = [];
    let currentChunk: TurnSlice[] = [];
    let currentTokens = 0;

    for (const turn of turns) {
        if (currentChunk.length > 0 && (currentTokens + turn.tokenCost) > targetChunkTokens) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }
        currentChunk.push(turn);
        currentTokens += turn.tokenCost;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

function buildStagedSummaryMessage(messages: LLMMessage[], droppedTurns: TurnSlice[]): LLMMessage {
    const averageTurnTokens = droppedTurns.length > 0
        ? droppedTurns.reduce((total, turn) => total + turn.tokenCost, 0) / droppedTurns.length
        : 0;
    const targetChunkTokens = clampNumber(Math.round(averageTurnTokens * 2.4), 320, 2_000);
    const chunks = chunkTurnsByTokenBudget(droppedTurns, targetChunkTokens);

    const stageLines: string[] = [];
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        const firstTurn = chunk[0];
        const lastTurn = chunk[chunk.length - 1];
        const firstSnippet = buildTurnSnippet(messages, firstTurn, 170);
        const lastSnippet = buildTurnSnippet(messages, lastTurn, 170);
        stageLines.push(`Stage ${chunkIndex + 1}: ${firstSnippet}`);
        if (firstTurn !== lastTurn) {
            stageLines.push(`Stage ${chunkIndex + 1} end: ${lastSnippet}`);
        }
    }

    const summaryLines = stageLines.slice(0, SUMMARY_MAX_LINES);
    return {
        role: "assistant",
        content: [
            "[Context summary generated to fit model window]",
            `Dropped turns: ${droppedTurns.length}`,
            ...summaryLines.map((line) => `- ${line}`),
        ].join("\n"),
    };
}

function truncateTailByTokenBudget(messages: LLMMessage[], maxTokens: number): LLMMessage[] {
    if (messages.length === 0) return [];
    const kept: LLMMessage[] = [];
    let runningTokens = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const candidate = messages[index];
        const tokenCost = estimateMessageTokens(candidate);
        if (kept.length > 0 && (runningTokens + tokenCost) > maxTokens) {
            continue;
        }
        kept.unshift(candidate);
        runningTokens += tokenCost;
        if (runningTokens >= maxTokens) break;
    }
    return kept;
}

export interface ManagedHistoryResult {
    messages: LLMMessage[];
    trimmedMessageCount: number;
    droppedTurnCount: number;
    summaryInjected: boolean;
    estimatedTokens: number;
}

export function buildManagedHistory(
    sourceMessages: LLMMessage[],
    maxHistoryTokens: number,
): ManagedHistoryResult {
    if (sourceMessages.length === 0) {
        return {
            messages: [],
            trimmedMessageCount: 0,
            droppedTurnCount: 0,
            summaryInjected: false,
            estimatedTokens: 0,
        };
    }

    const normalized: LLMMessage[] = [];
    let trimmedMessageCount = 0;
    for (const message of sourceMessages) {
        const normalizedMessage = normalizeHistoryMessage(message);
        if (normalizedMessage.trimmed) {
            trimmedMessageCount += 1;
        }
        normalized.push(normalizedMessage.message);
    }

    const currentTokens = normalized.reduce((total, message) => total + estimateMessageTokens(message), 0);
    if (currentTokens <= maxHistoryTokens) {
        return {
            messages: normalized,
            trimmedMessageCount,
            droppedTurnCount: 0,
            summaryInjected: false,
            estimatedTokens: currentTokens,
        };
    }

    const turns = splitTurns(normalized);
    const keptTurns: TurnSlice[] = [];
    let runningTokens = 0;

    for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index];
        if (keptTurns.length > 0 && (runningTokens + turn.tokenCost) > maxHistoryTokens) {
            continue;
        }
        keptTurns.unshift(turn);
        runningTokens += turn.tokenCost;
        if (runningTokens >= maxHistoryTokens) break;
    }

    const keptTurnSet = new Set(keptTurns);
    const droppedTurns = turns.filter((turn) => !keptTurnSet.has(turn));

    let managedMessages = keptTurns.flatMap((turn) => normalized.slice(turn.startIndex, turn.endIndex + 1));
    let summaryInjected = false;

    if (droppedTurns.length > 0) {
        const summaryMessage = buildStagedSummaryMessage(normalized, droppedTurns);
        const summaryWithTailFallback = preserveHeadTail(summaryMessage.content);
        managedMessages = [{
            ...summaryMessage,
            content: summaryWithTailFallback,
        }, ...managedMessages];
        summaryInjected = true;
    }

    let estimatedTokens = managedMessages.reduce((total, message) => total + estimateMessageTokens(message), 0);
    if (estimatedTokens > maxHistoryTokens) {
        managedMessages = truncateTailByTokenBudget(managedMessages, maxHistoryTokens);
        estimatedTokens = managedMessages.reduce((total, message) => total + estimateMessageTokens(message), 0);
    }

    return {
        messages: managedMessages,
        trimmedMessageCount,
        droppedTurnCount: droppedTurns.length,
        summaryInjected,
        estimatedTokens,
    };
}

export interface ToolResultRepairResult {
    messages: LLMMessage[];
    injectedCount: number;
}

function uniqueToolCallId(call: LLMToolCall, index: number): string {
    const id = String(call.id || "").trim();
    return id || `missing-call-id-${index + 1}`;
}

function hasToolResultMessage(message: LLMMessage): boolean {
    return message.role === "tool";
}

export function injectOrphanToolResultErrors(messages: LLMMessage[]): ToolResultRepairResult {
    if (messages.length === 0) {
        return { messages, injectedCount: 0 };
    }

    const repaired: LLMMessage[] = [];
    let injectedCount = 0;
    let index = 0;

    while (index < messages.length) {
        const message = messages[index];
        repaired.push(message);

        if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
            const pending = new Map<string, LLMToolCall>();
            message.toolCalls.forEach((call, callIndex) => {
                pending.set(uniqueToolCallId(call, callIndex), call);
            });

            let nextIndex = index + 1;
            while (nextIndex < messages.length && hasToolResultMessage(messages[nextIndex])) {
                const toolMessage = messages[nextIndex];
                repaired.push(toolMessage);
                const toolCallId = typeof toolMessage.toolCallId === "string" && toolMessage.toolCallId.trim().length > 0
                    ? toolMessage.toolCallId.trim()
                    : "";
                if (toolCallId && pending.has(toolCallId)) {
                    pending.delete(toolCallId);
                }
                nextIndex += 1;
            }

            if (pending.size > 0) {
                for (const [pendingId, pendingCall] of pending.entries()) {
                    repaired.push({
                        role: "tool",
                        name: pendingCall.name,
                        toolCallId: pendingId,
                        content: `${TOOL_ERROR_PREFIX} for '${pendingCall.name}' (${pendingId}). Treat this tool call as failed.`,
                    });
                    injectedCount += 1;
                }
            }

            index = nextIndex;
            continue;
        }

        index += 1;
    }

    return {
        messages: repaired,
        injectedCount,
    };
}

export function inferContextWindowTokens(modelId: string): number | null {
    const normalized = modelId.trim().toLowerCase();
    if (!normalized) return null;

    const kMatch = normalized.match(/(?:^|[^a-z0-9])(\d{1,4})k(?:[^a-z0-9]|$)/i);
    if (kMatch) {
        const kValue = Number.parseInt(kMatch[1], 10);
        if (Number.isFinite(kValue) && kValue >= 4 && kValue <= 2_000) {
            return kValue * 1_000;
        }
    }

    const rawMatch = normalized.match(/(?:^|[^a-z0-9])(\d{4,6})(?:[^a-z0-9]|$)/i);
    if (rawMatch) {
        const rawValue = Number.parseInt(rawMatch[1], 10);
        if (Number.isFinite(rawValue) && rawValue >= 4_096 && rawValue <= 1_000_000) {
            return rawValue;
        }
    }

    return null;
}

const TOOL_RESULT_PRUNE_PREFIX = "[Tool result pruned after cache expiry]";

const PROVIDER_TOOL_CACHE_TTL_MS: Record<string, number> = {
    openai: 5 * 60_000,
    anthropic: 5 * 60_000,
    google: 5 * 60_000,
    groq: 3 * 60_000,
};

function providerToolCacheTtlMs(providerId: string): number {
    const normalized = providerId.trim().toLowerCase();
    return PROVIDER_TOOL_CACHE_TTL_MS[normalized] || (4 * 60_000);
}

function isAlreadyPrunedToolResult(content: string): boolean {
    return content.trimStart().startsWith(TOOL_RESULT_PRUNE_PREFIX);
}

function buildPrunedToolResultMarker(toolName: string | undefined, toolCallId: string, originalContent: string): string {
    const normalizedName = (toolName || "tool").trim() || "tool";
    return `${TOOL_RESULT_PRUNE_PREFIX} ${normalizedName} (${toolCallId}); original length=${originalContent.length} chars.`;
}

export interface CacheAwareToolPruneResult {
    messages: LLMMessage[];
    prunedCount: number;
    estimatedTokens: number;
}

export interface CacheAwareToolPruneOptions {
    providerId: string;
    now: number;
    maxPromptTokens: number;
    toolResultInsertedAtByCallId: Map<string, number>;
}

export function pruneExpiredToolResults(
    sourceMessages: LLMMessage[],
    options: CacheAwareToolPruneOptions,
): CacheAwareToolPruneResult {
    let estimatedTokens = estimateHistoryTokens(sourceMessages);
    if (estimatedTokens <= options.maxPromptTokens) {
        return {
            messages: sourceMessages,
            prunedCount: 0,
            estimatedTokens,
        };
    }

    const ttlMs = providerToolCacheTtlMs(options.providerId);
    const clonedMessages = [...sourceMessages];
    let prunedCount = 0;

    for (let index = 0; index < clonedMessages.length; index += 1) {
        if (estimatedTokens <= options.maxPromptTokens) break;

        const message = clonedMessages[index];
        if (message.role !== "tool") continue;
        if (isAlreadyPrunedToolResult(message.content || "")) continue;

        const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId.trim() : "";
        if (!toolCallId) continue;

        const insertedAt = options.toolResultInsertedAtByCallId.get(toolCallId);
        if (typeof insertedAt !== "number") continue;
        const ageMs = options.now - insertedAt;
        if (ageMs < ttlMs) continue;

        const nextContent = buildPrunedToolResultMarker(message.name, toolCallId, message.content || "");
        clonedMessages[index] = {
            ...message,
            content: nextContent,
        };
        prunedCount += 1;
        estimatedTokens = estimateHistoryTokens(clonedMessages);
    }

    return {
        messages: clonedMessages,
        prunedCount,
        estimatedTokens,
    };
}
