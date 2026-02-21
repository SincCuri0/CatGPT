import { NextRequest } from "next/server";

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const SECRET_ASSIGNMENT_PATTERN = /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\b\s*[:=]\s*)(["']?)([^"',;\s]+)(\2)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/\-=]{8,})\b/g;

function maskDebugText(value: string): string {
    return value
        .replace(SECRET_ASSIGNMENT_PATTERN, (_full, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`)
        .replace(BEARER_PATTERN, (_full, prefix: string) => `${prefix}[REDACTED]`);
}

function redactDebugValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") {
        return maskDebugText(value);
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((entry) => redactDebugValue(entry, seen));
    }
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
        output[key] = redactDebugValue(entry, seen);
    }
    return output;
}

export function isDebugRequest(req: Pick<NextRequest, "headers"> | null | undefined): boolean {
    if (!req) return false;
    const headerValue = req.headers.get("x-debug-logs");
    if (!headerValue) return false;
    return TRUE_VALUES.has(headerValue.trim().toLowerCase());
}

export function debugRouteLog(enabled: boolean, route: string, message: string, data?: unknown) {
    if (!enabled) return;
    const safeMessage = maskDebugText(message);
    if (typeof data === "undefined") {
        console.debug(`[debug][${route}] ${safeMessage}`);
        return;
    }
    console.debug(`[debug][${route}] ${safeMessage}`, redactDebugValue(data));
}

export function debugRouteError(
    enabled: boolean,
    route: string,
    message: string,
    error: unknown,
    data?: unknown,
) {
    if (!enabled) return;
    const safeMessage = maskDebugText(message);
    if (typeof data === "undefined") {
        console.error(`[debug][${route}] ${safeMessage}`, redactDebugValue(error));
        return;
    }
    console.error(`[debug][${route}] ${safeMessage}`, redactDebugValue(data), redactDebugValue(error));
}
