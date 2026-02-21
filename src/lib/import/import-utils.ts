import { prisma } from "../db";

export async function ensureDefaultUser() {
    // In local-first mode, we just need a stable user.
    // We'll check for any user or create one.

    const existing = await prisma.user.findFirst();
    if (existing) return existing;

    return await prisma.user.create({
        data: {
            displayName: "Local User",
            email: "local@catgpt.app"
        }
    });
}
