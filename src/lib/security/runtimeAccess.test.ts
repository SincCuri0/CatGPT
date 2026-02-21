import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { authorizeRuntimeAccess } from "@/lib/security/runtimeAccess";

function makeRequest(headers?: Record<string, string>): NextRequest {
    return new NextRequest("http://localhost:3000/api/runtime/tasks", {
        method: "GET",
        headers,
    });
}

describe("authorizeRuntimeAccess", () => {
    it("allows runtime access in non-production when admin token is not configured", () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalToken = process.env.RUNTIME_ADMIN_TOKEN;
        process.env.NODE_ENV = "development";
        delete process.env.RUNTIME_ADMIN_TOKEN;
        try {
            const decision = authorizeRuntimeAccess(makeRequest());
            expect(decision.ok).toBe(true);
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
            process.env.RUNTIME_ADMIN_TOKEN = originalToken;
        }
    });

    it("rejects missing token in production", () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalToken = process.env.RUNTIME_ADMIN_TOKEN;
        process.env.NODE_ENV = "production";
        process.env.RUNTIME_ADMIN_TOKEN = "expected-token";
        try {
            const decision = authorizeRuntimeAccess(makeRequest());
            expect(decision.ok).toBe(false);
            expect(decision.reason).toContain("Missing runtime admin token");
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
            process.env.RUNTIME_ADMIN_TOKEN = originalToken;
        }
    });

    it("accepts valid x-runtime-token header", () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalToken = process.env.RUNTIME_ADMIN_TOKEN;
        process.env.NODE_ENV = "production";
        process.env.RUNTIME_ADMIN_TOKEN = "expected-token";
        try {
            const decision = authorizeRuntimeAccess(makeRequest({
                "x-runtime-token": "expected-token",
            }));
            expect(decision.ok).toBe(true);
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
            process.env.RUNTIME_ADMIN_TOKEN = originalToken;
        }
    });

    it("accepts valid bearer token", () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalToken = process.env.RUNTIME_ADMIN_TOKEN;
        process.env.NODE_ENV = "production";
        process.env.RUNTIME_ADMIN_TOKEN = "expected-token";
        try {
            const decision = authorizeRuntimeAccess(makeRequest({
                authorization: "Bearer expected-token",
            }));
            expect(decision.ok).toBe(true);
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
            process.env.RUNTIME_ADMIN_TOKEN = originalToken;
        }
    });
});
