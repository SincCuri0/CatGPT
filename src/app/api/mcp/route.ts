/**
 * MCP API: agent-to-agent communication and capability management
 */

import { NextRequest, NextResponse } from "next/server";
import { mcpServer } from "@/lib/mcp/server";


// POST /api/mcp/message - Send an MCP message
export async function POST(req: NextRequest) {
  try {
    const message = await req.json();

    // Validate required fields
    if (!message.senderId || !message.type) {
      return NextResponse.json(
        { error: "senderId and type required" },
        { status: 400 },
      );
    }

    // Send message through MCP server
    const response = await mcpServer.sendMessage(message);

    // Emit realtime event
    // Emit realtime event
    const { runtimeStateSyncService } = await import("@/lib/runtime/services/stateSyncService");
    runtimeStateSyncService.publish(
      `mcp:${message.senderId}`,
      "mcp.message.sent",
      { message: response } as unknown as Record<string, unknown>
    );

    return NextResponse.json({ response });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to send MCP message",
      },
      { status: 500 },
    );
  }
}

// GET /api/mcp/agents - List registered agents
export async function GET(req: NextRequest) {
  try {
    const agentId = req.nextUrl.searchParams.get("agentId");

    if (agentId) {
      const agent = mcpServer.getAgent(agentId);
      if (!agent) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }
      return NextResponse.json({ agent });
    }

    const agents = mcpServer.getAllAgents();
    return NextResponse.json({ agents });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to list agents",
      },
      { status: 500 },
    );
  }
}
