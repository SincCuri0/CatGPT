import { DEBUG_LOGS_STORAGE_KEY } from "@/lib/debug/constants";

export function isClientDebugEnabled(): boolean {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(DEBUG_LOGS_STORAGE_KEY) === "true";
}

export function getClientDebugHeaders(): Record<string, string> {
    return isClientDebugEnabled() ? { "x-debug-logs": "1" } : {};
}

export function debugClientLog(scope: string, ...args: unknown[]) {
    if (!isClientDebugEnabled()) return;
    console.debug(`[debug:${scope}]`, ...args);
}

export function debugClientError(scope: string, error: unknown, ...args: unknown[]) {
    if (!isClientDebugEnabled()) return;
    console.error(`[debug:${scope}]`, ...args, error);
}
