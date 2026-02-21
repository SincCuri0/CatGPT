import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "path";

/**
 * Prisma client singleton.
 *
 * In development, Next.js hot-reloads modules which would create multiple
 * PrismaClient instances. We cache on `globalThis` to prevent connection
 * exhaustion.
 */

const globalForPrisma = globalThis as unknown as {
    __catgpt_prisma_v4?: PrismaClient;
};

// Resolve the SQLite file path relative to the project root
const dbPath = path.resolve(process.cwd(), "prisma/data/catgpt.db");

const adapter = new PrismaBetterSqlite3({ url: `file:${dbPath}` });

export const prisma =
    globalForPrisma.__catgpt_prisma_v4 ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
    globalForPrisma.__catgpt_prisma_v4 = prisma;
}
