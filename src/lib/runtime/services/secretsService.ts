import type { ToolResult } from "@/lib/core/types";
import type { RuntimeHookRegistry } from "@/lib/runtime/hooks/registry";

const REDACTED_TOKEN = "[REDACTED]";
const PLACEHOLDER_PATTERN = /\{\{\s*secret:([A-Za-z0-9_]+)\s*\}\}/g;
const SECRET_ASSIGNMENT_PATTERN = /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\b\s*[:=]\s*)(["']?)([^"',;\s]+)(\2)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/\-=]{8,})\b/g;

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSecretValue(value: string): string {
    return value.replace(/\u0000/g, "").trim();
}

function dedupeSecrets(values: string[]): string[] {
    const unique = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
        const normalized = normalizeSecretValue(value);
        if (normalized.length < 6) continue;
        if (unique.has(normalized)) continue;
        unique.add(normalized);
        output.push(normalized);
    }
    output.sort((left, right) => right.length - left.length);
    return output;
}

function maskKnownSecrets(input: string, secretValues: string[]): string {
    let output = input;
    for (const secret of secretValues) {
        const pattern = new RegExp(escapeRegex(secret), "g");
        output = output.replace(pattern, REDACTED_TOKEN);
    }
    return output;
}

function maskPatternSecrets(input: string): string {
    return input
        .replace(SECRET_ASSIGNMENT_PATTERN, (_full, prefix: string, quote: string) => `${prefix}${quote}${REDACTED_TOKEN}${quote}`)
        .replace(BEARER_PATTERN, (_full, prefix: string) => `${prefix}${REDACTED_TOKEN}`);
}

function deepMaskUnknown(
    value: unknown,
    maskText: (text: string) => string,
    seen: WeakSet<object>,
): unknown {
    if (typeof value === "string") {
        return maskText(value);
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) {
        return value;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((item) => deepMaskUnknown(item, maskText, seen));
    }
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
        output[key] = deepMaskUnknown(entry, maskText, seen);
    }
    return output;
}

export interface SecretsRedactor {
    readonly secretValues: string[];
    maskText: (text: string) => string;
    maskUnknown: (value: unknown) => unknown;
    maskToolResult: (result: ToolResult) => ToolResult;
}

export function buildSecretValuesFromRecord(values: Record<string, string | null | undefined>): string[] {
    return dedupeSecrets(Object.values(values).filter((value): value is string => typeof value === "string"));
}

export function createSecretsRedactor(secretValues: string[]): SecretsRedactor {
    const normalizedSecrets = dedupeSecrets(secretValues);
    const maskText = (text: string): string => {
        if (!text) return text;
        const knownMasked = normalizedSecrets.length > 0 ? maskKnownSecrets(text, normalizedSecrets) : text;
        return maskPatternSecrets(knownMasked);
    };
    const maskUnknown = (value: unknown): unknown => deepMaskUnknown(value, maskText, new WeakSet());

    return {
        secretValues: normalizedSecrets,
        maskText,
        maskUnknown,
        maskToolResult: (result: ToolResult): ToolResult => ({
            ...result,
            output: typeof result.output === "string" ? maskText(result.output) : result.output,
            error: typeof result.error === "string" ? maskText(result.error) : result.error,
            artifacts: result.artifacts.map((artifact) => ({
                ...artifact,
                path: typeof artifact.path === "string" ? maskText(artifact.path) : artifact.path,
                metadata: artifact.metadata ? maskUnknown(artifact.metadata) as Record<string, unknown> : artifact.metadata,
            })),
            checks: result.checks.map((check) => ({
                ...check,
                description: maskText(check.description),
                details: typeof check.details === "string" ? maskText(check.details) : check.details,
            })),
        }),
    };
}

export function registerSecretsRedactionHooks(
    registry: RuntimeHookRegistry,
    redactor: SecretsRedactor,
): void {
    registry.register("tool_after", (event) => {
        const candidate = event.result;
        if (!candidate || typeof candidate !== "object") return;
        if (!("ok" in candidate) || !("artifacts" in candidate) || !("checks" in candidate)) return;
        event.result = redactor.maskToolResult(candidate as ToolResult);
    }, { id: "secrets-tool-after", priority: -100 });

    registry.register("response_stream", (event) => {
        event.chunk = redactor.maskText(event.chunk || "");
    }, { id: "secrets-response-stream", priority: -100 });

    registry.register("error_format", (event) => {
        if (typeof event.formattedMessage === "string") {
            event.formattedMessage = redactor.maskText(event.formattedMessage);
        }
        if (event.error instanceof Error) {
            event.error.message = redactor.maskText(event.error.message);
        } else if (typeof event.error === "string") {
            event.error = redactor.maskText(event.error);
        }
    }, { id: "secrets-error-format", priority: -100 });

    registry.register("run_end", (event) => {
        if (typeof event.output === "string") {
            event.output = redactor.maskText(event.output);
        }
    }, { id: "secrets-run-end", priority: -100 });
}

function replaceSecretPlaceholdersInString(
    value: string,
    secretValues: Record<string, string> | undefined,
): string {
    if (!secretValues || Object.keys(secretValues).length === 0) return value;
    return value.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
        const normalizedKey = key.trim();
        const found = secretValues[normalizedKey] || secretValues[normalizedKey.toUpperCase()];
        if (!found) return REDACTED_TOKEN;
        return found;
    });
}

function deepReplaceSecretPlaceholders(
    value: unknown,
    secretValues: Record<string, string> | undefined,
    seen: WeakSet<object>,
): unknown {
    if (typeof value === "string") {
        return replaceSecretPlaceholdersInString(value, secretValues);
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) {
        return value;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((entry) => deepReplaceSecretPlaceholders(entry, secretValues, seen));
    }
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
        output[key] = deepReplaceSecretPlaceholders(entry, secretValues, seen);
    }
    return output;
}

export function replaceSecretPlaceholdersInArgs<T>(
    value: T,
    secretValues: Record<string, string> | undefined,
): T {
    return deepReplaceSecretPlaceholders(value, secretValues, new WeakSet()) as T;
}
