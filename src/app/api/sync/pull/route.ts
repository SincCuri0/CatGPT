import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ensureDefaultUser } from "@/lib/import/import-utils";
import { AgentConfig } from "@/lib/core/Agent";
import { Conversation, Message } from "@/lib/conversations";

export async function GET() {
    try {
        const user = await ensureDefaultUser();

        // 0. Check Import Status
        const importCount = await prisma.importRecord.count({
            where: { userId: user.id }
        });
        const hasImportedData = importCount > 0;

        // 1. Fetch Agents
        const dbAgents = await prisma.agent.findMany({
            where: { userId: user.id }
        });

        const agents: AgentConfig[] = dbAgents.map(a => ({
            id: a.id,
            name: a.name,
            role: a.role,
            description: a.description || undefined,
            systemPrompt: a.systemPrompt,
            style: (a.style as any) || "assistant",
            voiceId: a.voiceId || undefined,
            provider: a.provider || undefined,
            model: a.model || undefined,
            tools: a.tools ? JSON.parse(a.tools) : [],
        }));

        // 2. Fetch Conversations
        const dbConversations = await prisma.conversation.findMany({
            where: { userId: user.id, isArchived: false },
            include: { messages: { orderBy: { sortOrder: "asc" } } },
            orderBy: { updatedAt: "desc" }
        });

        const conversations: Conversation[] = dbConversations.map(c => ({
            id: c.id,
            agentId: c.agentId || "", // Frontend expects string
            title: c.title,
            createdAt: c.createdAt.getTime(),
            updatedAt: c.updatedAt.getTime(),
            messages: c.messages.map(m => {
                const msg: Message = {
                    id: m.id,
                    role: m.role as any,
                    content: m.content,
                    timestamp: m.createdAt.getTime(),
                    name: m.name || undefined,
                    agentId: m.agentId || undefined,
                    // Map other fields if needed
                };
                return msg;
            }),
        }));

        return NextResponse.json({ agents, conversations, hasImportedData });
    } catch (error) {
        console.error("Sync pull failed:", error);
        return NextResponse.json({ error: "Failed to fetch data" }, { status: 500 });
    }
}
