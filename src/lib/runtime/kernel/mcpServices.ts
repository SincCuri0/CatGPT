import { NextRequest, NextResponse } from "next/server";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import {
    MCP_SETTINGS_JSON_SCHEMA,
    MCP_SERVICE_CONFIG_JSON_SCHEMA,
} from "@/lib/settings/schema";
import { mcpRuntimeService } from "@/lib/runtime/services/mcpRuntimeService";

export async function executeMcpServicesGet(_req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        debugRouteLog(debugEnabled, "api/mcp/services", "GET request started");
        const statuses = await mcpRuntimeService.getServiceStatuses();

        return NextResponse.json({
            services: statuses,
            schema: {
                mcp: MCP_SETTINGS_JSON_SCHEMA,
                mcpService: MCP_SERVICE_CONFIG_JSON_SCHEMA,
            },
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/mcp/services", "Unhandled error in GET", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
