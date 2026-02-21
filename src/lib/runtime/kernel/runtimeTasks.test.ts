import { describe, expect, it, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { RuntimeTask } from "@/lib/runtime/services/taskSchedulerService";

const listMock = vi.fn();
const enqueueMock = vi.fn();
const cancelMock = vi.fn();
const repairMock = vi.fn();
const authorizeMock = vi.fn();

vi.mock("@/lib/runtime/services/taskSchedulerService", () => ({
    runtimeTaskSchedulerService: {
        list: listMock,
        enqueue: enqueueMock,
        cancel: cancelMock,
        repairStaleRunningTasks: repairMock,
    },
}));

vi.mock("@/lib/security/runtimeAccess", () => ({
    authorizeRuntimeAccess: authorizeMock,
}));

import { executeRuntimeTasksGet, executeRuntimeTasksPost } from "@/lib/runtime/kernel/runtimeTasks";

function buildTask(id: string, status: RuntimeTask["status"] = "queued"): RuntimeTask {
    const now = Date.now();
    return {
        id,
        key: id,
        kind: "adhoc",
        status,
        createdAt: now,
        updatedAt: now,
        scheduledAt: now,
        attempts: 0,
        maxAttempts: 2,
        context: {},
        payload: {},
    };
}

describe("runtimeTasks kernel", () => {
    beforeEach(() => {
        listMock.mockReset();
        enqueueMock.mockReset();
        cancelMock.mockReset();
        repairMock.mockReset();
        authorizeMock.mockReset();
        authorizeMock.mockReturnValue({ ok: true });
        listMock.mockResolvedValue([]);
        enqueueMock.mockResolvedValue(buildTask("task-1"));
        cancelMock.mockResolvedValue(null);
        repairMock.mockResolvedValue(0);
    });

    it("normalizes GET filters and forwards them to scheduler list", async () => {
        const tasks = [buildTask("task-a", "queued"), buildTask("task-b", "running")];
        listMock.mockResolvedValueOnce(tasks);

        const req = new NextRequest("http://localhost:3000/api/runtime/tasks?limit=900&status=queued,running,invalid&kind=planned,noop");
        const response = await executeRuntimeTasksGet(req, false);

        expect(response.status).toBe(200);
        expect(listMock).toHaveBeenCalledTimes(1);
        expect(listMock).toHaveBeenCalledWith({
            limit: 500,
            status: ["queued", "running"],
            kind: ["planned"],
        });

        const body = await response.json();
        expect(body.tasks).toHaveLength(2);
    });

    it("enqueues task with sanitized payload from POST action=enqueue", async () => {
        const req = new NextRequest("http://localhost:3000/api/runtime/tasks", {
            method: "POST",
            body: JSON.stringify({
                action: "enqueue",
                task: {
                    key: " nightly-scan ",
                    kind: "planned",
                    scheduledAt: 1234.9,
                    maxAttempts: 4.7,
                    context: {
                        agentId: "cat-1",
                        ignored: 12,
                    },
                    payload: {
                        mode: "full",
                    },
                },
            }),
            headers: {
                "content-type": "application/json",
            },
        });

        const response = await executeRuntimeTasksPost(req, false);

        expect(response.status).toBe(200);
        expect(enqueueMock).toHaveBeenCalledTimes(1);
        expect(enqueueMock).toHaveBeenCalledWith({
            key: "nightly-scan",
            kind: "planned",
            scheduledAt: 1234,
            maxAttempts: 4,
            context: {
                agentId: "cat-1",
            },
            payload: {
                mode: "full",
            },
        });

        const body = await response.json();
        expect(body.task?.id).toBe("task-1");
    });

    it("returns 404 when cancel action targets missing task", async () => {
        const req = new NextRequest("http://localhost:3000/api/runtime/tasks", {
            method: "POST",
            body: JSON.stringify({
                action: "cancel",
                taskId: "missing-task",
            }),
            headers: {
                "content-type": "application/json",
            },
        });

        const response = await executeRuntimeTasksPost(req, false);

        expect(response.status).toBe(404);
        expect(cancelMock).toHaveBeenCalledWith("missing-task", undefined);
    });

    it("repairs stale tasks through POST action=repair", async () => {
        repairMock.mockResolvedValueOnce(3);

        const req = new NextRequest("http://localhost:3000/api/runtime/tasks", {
            method: "POST",
            body: JSON.stringify({
                action: "repair",
                maxAgeMs: 60_000.4,
            }),
            headers: {
                "content-type": "application/json",
            },
        });

        const response = await executeRuntimeTasksPost(req, false);

        expect(response.status).toBe(200);
        expect(repairMock).toHaveBeenCalledWith(60_000);
        const body = await response.json();
        expect(body.repaired).toBe(3);
    });
});
