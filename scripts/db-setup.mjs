#!/usr/bin/env node
/**
 * CatGPT Database Setup Script
 *
 * For SQLite, this is almost trivial: run migrate → generate.
 * The .db file is auto-created by Prisma if it doesn't exist.
 *
 * Usage:
 *   npm run db:setup     — migrate + generate client
 *   npm run db:studio    — open Prisma Studio to browse data
 *   npm run db:reset     — wipe DB and re-apply all migrations
 */
import { execSync } from "child_process";

const LOG_PREFIX = "\x1b[36m[catgpt-db]\x1b[0m";

function log(msg) {
    console.log(`${LOG_PREFIX} ${msg}`);
}

function run(cmd) {
    log(`> ${cmd}`);
    execSync(cmd, { stdio: "inherit" });
}

async function main() {
    log("Setting up local SQLite database...");
    log("");

    // Run Prisma migrate — creates DB file + tables if needed
    try {
        run("npx prisma migrate deploy");
    } catch {
        log("No migrations yet, running initial migrate dev...");
        run("npx prisma migrate dev --name init --skip-generate");
    }

    // Generate Prisma client
    run("npx prisma generate");

    log("");
    log("✅ Database ready!");
    log("   Location: prisma/data/catgpt.db");
    log("   Browse:   npm run db:studio");
    log("");
}

main().catch((err) => {
    console.error(`\x1b[31m${LOG_PREFIX} Setup failed: ${err.message}\x1b[0m`);
    process.exit(1);
});
