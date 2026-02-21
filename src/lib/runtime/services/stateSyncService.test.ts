import { describe, expect, it } from "vitest";
import { RuntimeStateSyncService } from "@/lib/runtime/services/stateSyncService";

describe("RuntimeStateSyncService", () => {
    it("publishes sequence-ordered events and snapshots", () => {
        const service = new RuntimeStateSyncService();
        service.publish("run:abc", "started", { step: 1 }, "running");
        service.publish("run:abc", "tool", { tool: "search" }, "running");
        const snapshot = service.getSnapshot("run:abc");
        const events = service.getEventsSince("run:abc", 0);

        expect(snapshot.seq).toBe(2);
        expect(snapshot.version).toBe(3);
        expect(snapshot.status).toBe("running");
        expect(events).toHaveLength(2);
        expect(events[0].seq).toBe(1);
        expect(events[1].seq).toBe(2);
    });

    it("streams new events to subscribers", () => {
        const service = new RuntimeStateSyncService();
        const received: string[] = [];
        const unsubscribe = service.subscribe("agent:cat", (event) => {
            received.push(event.type);
        });

        service.publish("agent:cat", "run_started", { runId: "1" }, "running");
        service.publish("agent:cat", "run_completed", { runId: "1" }, "completed");
        unsubscribe();
        service.publish("agent:cat", "run_started", { runId: "2" }, "running");

        expect(received).toEqual(["run_started", "run_completed"]);
    });
});
