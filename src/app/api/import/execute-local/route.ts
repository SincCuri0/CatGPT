import { NextRequest, NextResponse } from "next/server";
import { importChatGPTConversations } from "@/lib/import/chatgpt-mapper";
import { ensureDefaultUser } from "@/lib/import/import-utils";
import { prisma } from "@/lib/db";
import type { ChatGPTDetails } from "@/lib/import/chatgpt-types";
import path from "path";
import fs from "fs/promises";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { conversationIds } = body as { conversationIds: string[] };

        if (!conversationIds || !Array.isArray(conversationIds)) {
            return NextResponse.json({ error: "Invalid conversation IDs" }, { status: 400 });
        }

        const filePath = path.join(process.cwd(), "ChatGPT Export", "conversations.json");

        // Read and parse file
        const raw = await fs.readFile(filePath, "utf-8");
        const allConversations: ChatGPTDetails[] = JSON.parse(raw);

        // Filter valid conversations to import
        const targets = allConversations.filter(c => conversationIds.includes(c.conversation_id));

        if (targets.length === 0) {
            return NextResponse.json({ success: true, count: 0 });
        }

        const user = await ensureDefaultUser();

        // Create/Find import record
        // We'll just create a new one for this batch or maybe reuse a "Manual Import" one?
        // Let's create a new one for tracking.
        const importRecord = await prisma.importRecord.create({
            data: {
                userId: user.id,
                source: "chatgpt-local",
                filename: "conversations.json",
                stats: JSON.stringify({
                    totalItems: targets.length,
                    status: "processing"
                }),
            },
        });

        // Run import
        // Note: We need a dummy 'scanResult' for the mapper if it relies on it for names.
        // If the mapper uses scanResult heavily, we might need to re-scan or pass minimal datum.
        // Looking at previous `execute/route.ts`, it passed `scanResult`.
        // Let's quickly re-scan to get the metadata needed for mapping (like inferred names).
        // Or better yet, we can modify the mapper to be robust, or just do a quick scan here.
        // Given `importChatGPTConversations` signature, let's see what it needs from scanResult.
        // It uses it for: `scanResult.gpts[id]` to get names.

        // So we MUST scan to get the names correct.
        const { scanChatGPTExport } = await import("@/lib/import/chatgpt-scanner");
        const scanResult = await scanChatGPTExport(filePath);

        const count = await importChatGPTConversations(targets, {
            userId: user.id,
            importRecordId: importRecord.id,
            scanResult
        });

        return NextResponse.json({
            success: true,
            importedConversations: count,
            importRecordId: importRecord.id
        });

    } catch (error) {
        console.error("Local import execution failed:", error);
        return NextResponse.json({
            error: "Import failed",
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
