import { NextRequest, NextResponse } from "next/server";
import { Agent, AgentConfig } from "@/lib/core/Agent";
import { Message } from "@/lib/core/types";
import { toolRegistry } from "@/lib/core/ToolRegistry";
import { getEnvVariable } from "@/lib/env";

// Import tools to ensure they are registered
import { FileSystemReadTool, FileSystemWriteTool, FileSystemListTool } from "@/lib/tools/computer/file_system";
import { ShellExecuteTool } from "@/lib/tools/computer/shell";
import { WebSearchTool } from "@/lib/tools/web/search";

// Register Tools (Idempotent)
toolRegistry.register(FileSystemReadTool);
toolRegistry.register(FileSystemWriteTool);
toolRegistry.register(FileSystemListTool);
toolRegistry.register(ShellExecuteTool);
toolRegistry.register(WebSearchTool);

export async function POST(req: NextRequest) {
    try {
        const apiKeyHeader = req.headers.get("x-groq-api-key");
        let apiKey = apiKeyHeader;

        // Fallback to server-side env variable
        if (!apiKey || apiKey === "null") {
            apiKey = await getEnvVariable("GROQ_API_KEY");
        }

        if (!apiKey) {
            return NextResponse.json({ error: "Missing API Key" }, { status: 401 });
        }

        const body = await req.json();
        const { message, history, agentConfig } = body;

        if (!message || !agentConfig) {
            return NextResponse.json({ error: "Invalid Request" }, { status: 400 });
        }

        // Instantiate Agent
        const agent = new Agent(agentConfig);

        // Get Available Tools
        const tools = toolRegistry.getAll();

        // Process Message
        // Add new user message to history for processing context
        const fullHistory: Message[] = [...history, { role: "user", content: message, timestamp: Date.now(), id: "temp" }];

        // Note: We don't pass 'message' separately because we appended it to history. 
        // But Agent.process expects 'history' (past) and generates response. 
        // Actually, Agent.process logic I wrote creates system message and then maps history.
        // So passing the full history including the new message is correct.

        const responseMsg = await agent.process(fullHistory, apiKey, tools);

        return NextResponse.json({ response: responseMsg.content });

    } catch (error: any) {
        console.error("Chat API Error:", error);
        return NextResponse.json(
            { error: "Internal Server Error", details: error.message },
            { status: 500 }
        );
    }
}
