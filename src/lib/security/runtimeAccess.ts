import { timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";

function safeEquals(left: string, right: string): boolean {
    const leftBuf = Buffer.from(left);
    const rightBuf = Buffer.from(right);
    if (leftBuf.length !== rightBuf.length) return false;
    return timingSafeEqual(leftBuf, rightBuf);
}

function extractProvidedToken(req: NextRequest): string {
    const fromHeader = req.headers.get("x-runtime-token")?.trim();
    if (fromHeader) return fromHeader;

    const authHeader = req.headers.get("authorization")?.trim() || "";
    const bearerPrefix = "bearer ";
    if (authHeader.toLowerCase().startsWith(bearerPrefix)) {
        return authHeader.slice(bearerPrefix.length).trim();
    }

    return "";
}

export interface RuntimeAccessDecision {
    ok: boolean;
    reason?: string;
}

export function authorizeRuntimeAccess(req: NextRequest): RuntimeAccessDecision {
    const expectedToken = (process.env.RUNTIME_ADMIN_TOKEN || "").trim();

    if (!expectedToken) {
        if ((process.env.NODE_ENV || "development") !== "production") {
            return { ok: true };
        }
        return {
            ok: false,
            reason: "Runtime admin token is not configured.",
        };
    }

    const providedToken = extractProvidedToken(req);
    if (!providedToken) {
        return {
            ok: false,
            reason: "Missing runtime admin token.",
        };
    }

    if (!safeEquals(providedToken, expectedToken)) {
        return {
            ok: false,
            reason: "Invalid runtime admin token.",
        };
    }

    return { ok: true };
}
