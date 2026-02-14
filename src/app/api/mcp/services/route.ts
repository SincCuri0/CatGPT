import { NextRequest, NextResponse } from "next/server";
import { debugRouteError, debugRouteLog, isDebugRequest } from "@/lib/debug/server";
import { readUserSettings } from "@/lib/settings/store";
import {
  DEFAULT_USER_SETTINGS,
  MCP_SETTINGS_JSON_SCHEMA,
  MCP_SERVICE_CONFIG_JSON_SCHEMA,
} from "@/lib/settings/schema";
import { mcpServiceManager } from "@/lib/mcp/manager";

export async function GET(req: NextRequest) {
  const debugEnabled = isDebugRequest(req);
  try {
    debugRouteLog(debugEnabled, "api/mcp/services", "GET request started");
    const settings = await readUserSettings();
    const services = settings.mcp.services || DEFAULT_USER_SETTINGS.mcp.services;
    const statuses = await mcpServiceManager.getServiceStatuses(services);

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

