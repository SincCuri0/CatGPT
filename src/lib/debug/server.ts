import { NextRequest } from "next/server";

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);

export function isDebugRequest(req: Pick<NextRequest, "headers"> | null | undefined): boolean {
    if (!req) return false;
    const headerValue = req.headers.get("x-debug-logs");
    if (!headerValue) return false;
    return TRUE_VALUES.has(headerValue.trim().toLowerCase());
}

export function debugRouteLog(enabled: boolean, route: string, message: string, data?: unknown) {
    if (!enabled) return;
    if (typeof data === "undefined") {
        console.debug(`[debug][${route}] ${message}`);
        return;
    }
    console.debug(`[debug][${route}] ${message}`, data);
}

export function debugRouteError(
    enabled: boolean,
    route: string,
    message: string,
    error: unknown,
    data?: unknown,
) {
    if (!enabled) return;
    if (typeof data === "undefined") {
        console.error(`[debug][${route}] ${message}`, error);
        return;
    }
    console.error(`[debug][${route}] ${message}`, data, error);
}
