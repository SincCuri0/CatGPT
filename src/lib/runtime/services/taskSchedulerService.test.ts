import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { RuntimeTaskSchedulerService } from "@/lib/runtime/services/taskSchedulerService";

async function createSchedulerForTest(): Promise<{ scheduler: RuntimeTaskSchedulerService; cleanup: () => Promise<void> }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "catgpt-scheduler-test-"));
    const storePath = path.join(root, "tasks.json");
    return {
        scheduler: new RuntimeTaskSchedulerService(storePath),
        cleanup: async () => {
            await fs.rm(root, { recursive: true, force: true });
        },
    };
}

describe("RuntimeTaskSchedulerService", () => {
    it("queues, acquires, and completes tasks", async () => {
        const { scheduler, cleanup } = await createSchedulerForTest();
        try {
            const task = await scheduler.enqueue({
                kind: "adhoc",
                context: { taskType: "test" },
                payload: { value: 1 },
            });
            const acquired = await scheduler.acquireDueTasks({ limit: 10, now: Date.now() });
            const target = acquired.find((entry) => entry.task.id === task.id);
            expect(target).toBeTruthy();
            if (!target) return;

            await scheduler.complete(target.lease, { ok: true });
            const listed = await scheduler.list({ status: "completed" });
            expect(listed.some((entry) => entry.id === task.id)).toBe(true);
        } finally {
            await cleanup();
        }
    });

    it("repairs stale running tasks", async () => {
        const { scheduler, cleanup } = await createSchedulerForTest();
        try {
            await scheduler.enqueue({
                kind: "planned",
                scheduledAt: Date.now() - 1_000,
                maxAttempts: 1,
            });
            const acquired = await scheduler.acquireDueTasks({ now: Date.now(), limit: 5 });
            expect(acquired.length).toBe(1);
            const repaired = await scheduler.repairStaleRunningTasks(0);
            expect(repaired).toBe(1);
            const failed = await scheduler.list({ status: "failed" });
            expect(failed.length).toBe(1);
        } finally {
            await cleanup();
        }
    });
});
