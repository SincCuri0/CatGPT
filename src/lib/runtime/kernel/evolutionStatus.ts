import { NextRequest, NextResponse } from "next/server";
import type { AgentConfig } from "@/lib/core/Agent";
import { getEvolutionStatusForAgent } from "@/lib/evolution/engine";
import { normalizeEvolutionConfig } from "@/lib/evolution/types";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import { isAgentConfigLike, isRecord } from "@/lib/runtime/kernel/validation";

export async function executeEvolutionStatusPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        debugRouteLog(debugEnabled, "api/evolution/status", "POST request started");
        const body = await req.json();
        if (!isRecord(body) || !isAgentConfigLike(body.agentConfig)) {
            return NextResponse.json({ error: "Invalid Request: missing agentConfig" }, { status: 400 });
        }

        const agentConfig = body.agentConfig as AgentConfig;
        const evolution = normalizeEvolutionConfig(agentConfig.evolution);
        if (!evolution.enabled) {
            return NextResponse.json({
                enabled: false,
                status: null,
            });
        }

        const status = await getEvolutionStatusForAgent(agentConfig);
        debugRouteLog(debugEnabled, "api/evolution/status", "Resolved evolution status", {
            agentId: agentConfig.id,
            level: status.profile.level,
            totalRuns: status.profile.totalRuns,
        });

        return NextResponse.json({
            enabled: true,
            status,
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/evolution/status", "Unhandled error in POST", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

