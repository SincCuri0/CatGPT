import { RuntimeError } from "@/lib/runtime/contracts/errors";
import { RuntimeResult, err, ok } from "@/lib/runtime/contracts/result";
import { RuntimeService, RuntimeServiceContext, RuntimeServiceHealth } from "@/lib/runtime/services/types";

export class RuntimeServiceRegistry<TEvents extends Record<string, unknown> = Record<string, unknown>> {
    private readonly services = new Map<string, RuntimeService<TEvents>>();
    private readonly startOrder: string[] = [];

    register(service: RuntimeService<TEvents>): void {
        const id = service.id.trim();
        if (!id) {
            throw new Error("Runtime service id cannot be empty.");
        }
        if (this.services.has(id)) {
            throw new Error(`Runtime service '${id}' is already registered.`);
        }
        this.services.set(id, { ...service, id });
    }

    get(id: string): RuntimeService<TEvents> | null {
        return this.services.get(id) || null;
    }

    list(): RuntimeService<TEvents>[] {
        return Array.from(this.services.values());
    }

    async startAll(context: RuntimeServiceContext<TEvents>): Promise<RuntimeResult<void>> {
        const pending = this.list();
        for (const service of pending) {
            try {
                await service.start(context);
                this.startOrder.push(service.id);
            } catch (error) {
                return err(
                    new RuntimeError(
                        "dependency_failed",
                        `Runtime service '${service.id}' failed to start.`,
                        { cause: error, details: { serviceId: service.id } },
                    ),
                );
            }
        }
        return ok(undefined);
    }

    async stopAll(context: RuntimeServiceContext<TEvents>): Promise<RuntimeResult<void>> {
        const started = [...this.startOrder].reverse();
        for (const serviceId of started) {
            const service = this.services.get(serviceId);
            if (!service?.stop) continue;
            try {
                await service.stop(context);
            } catch (error) {
                return err(
                    new RuntimeError(
                        "dependency_failed",
                        `Runtime service '${serviceId}' failed to stop.`,
                        { cause: error, details: { serviceId } },
                    ),
                );
            }
        }
        this.startOrder.length = 0;
        return ok(undefined);
    }

    async health(context: RuntimeServiceContext<TEvents>): Promise<Record<string, RuntimeServiceHealth>> {
        const out: Record<string, RuntimeServiceHealth> = {};
        for (const service of this.services.values()) {
            if (!service.health) {
                out[service.id] = { ok: true, updatedAt: context.clock() };
                continue;
            }
            try {
                const health = await service.health(context);
                out[service.id] = health;
            } catch (error) {
                out[service.id] = {
                    ok: false,
                    updatedAt: context.clock(),
                    details: {
                        error: error instanceof Error ? error.message : "Unknown health-check failure.",
                    },
                };
            }
        }
        return out;
    }
}

