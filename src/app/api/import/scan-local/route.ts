import { NextResponse } from "next/server";
import { scanChatGPTExport } from "@/lib/import/chatgpt-scanner";
import path from "path";
import fs from "fs/promises";
import { prisma } from "@/lib/db";

export async function GET() {
    try {
        const filePath = path.join(process.cwd(), "ChatGPT Export", "conversations.json");

        // Check if file exists
        try {
            await fs.access(filePath);
        } catch {
            return NextResponse.json({
                error: "File not found",
                details: "Please ensure 'ChatGPT Export/conversations.json' exists in the project root."
            }, { status: 404 });
        }

        // Scan the file
        const result = await scanChatGPTExport(filePath);

        // Check which conversations are already imported
        // We look for conversations where sourceId matches the scanned conversation ID
        const importedConversations = await prisma.conversation.findMany({
            where: {
                source: "chatgpt",
                sourceId: {
                    in: result.conversations.map(c => c.id)
                }
            },
            select: {
                sourceId: true
            }
        });

        const importedSet = new Set(importedConversations.map(c => c.sourceId));

        // Mark as imported in the result
        result.conversations.forEach(c => {
            c.isImported = importedSet.has(c.id);
        });

        return NextResponse.json(result);

    } catch (error) {
        console.error("Local scan failed:", error);
        return NextResponse.json({
            error: "Failed to scan local export file",
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
