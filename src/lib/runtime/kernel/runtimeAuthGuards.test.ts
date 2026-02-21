import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { executeRuntimeStateGet } from "@/lib/runtime/kernel/runtimeState";
import { executeRuntimeTasksGet } from "@/lib/runtime/kernel/runtimeTasks";
import { executeRuntimeObservabilityGet } from "@/lib/runtime/kernel/runtimeObservability";

function withRuntimeEnv<T>(action: () => Promise<T>): Promise<T> {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalToken = process.env.RUNTIME_ADMIN_TOKEN;
    process.env.NODE_ENV = "production";
    process.env.RUNTIME_ADMIN_TOKEN = "test-runtime-token";
    return action().finally(() => {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.RUNTIME_ADMIN_TOKEN = originalToken;
    });
}

describe("runtime kernel auth guards", () => {
    it("rejects runtime state GET without runtime token in production", async () => {
        await withRuntimeEnv(async () => {
            const req = new NextRequest("http://localhost:3000/api/runtime/state");
            const response = await executeRuntimeStateGet(req, false);
            expect(response.status).toBe(401);
            const body = await response.json();
            expect(String(body.error || "")).toContain("runtime admin token");
        });
    });

    it("rejects runtime tasks GET without runtime token in production", async () => {
        await withRuntimeEnv(async () => {
            const req = new NextRequest("http://localhost:3000/api/runtime/tasks");
            const response = await executeRuntimeTasksGet(req, false);
            expect(response.status).toBe(401);
            const body = await response.json();
            expect(String(body.error || "")).toContain("runtime admin token");
        });
    });

    it("rejects runtime observability GET without runtime token in production", async () => {
        await withRuntimeEnv(async () => {
            const req = new NextRequest("http://localhost:3000/api/runtime/observability");
            const response = await executeRuntimeObservabilityGet(req, false);
            expect(response.status).toBe(401);
            const body = await response.json();
            expect(String(body.error || "")).toContain("runtime admin token");
        });
    });

    it("allows runtime state GET with valid runtime token", async () => {
        await withRuntimeEnv(async () => {
            const req = new NextRequest("http://localhost:3000/api/runtime/state", {
                headers: {
                    "x-runtime-token": "test-runtime-token",
                },
            });
            const response = await executeRuntimeStateGet(req, false);
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(Array.isArray(body.channels)).toBe(true);
        });
    });
});
