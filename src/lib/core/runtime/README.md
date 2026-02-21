# Runtime V2 Foundations

This runtime replaces the previous text-JSON fallback tool path with native tool-calling semantics.

## What is in place

- Native tool loop in `Agent.process` using provider tool call messages + tool result messages.
- Canonical tool execution metrics (attempted/succeeded/failed/malformed + verified file/shell effects).
- Provider adapters that preserve assistant tool calls and tool results across turns.
- Sub-agent runtime tool:
  - `subagents` (`action`: `spawn` | `await` | `list` | `cancel`)
- Queued sub-agent coordinator with bounded concurrency.
- Durable run store (`data/subagent-runs.json` by default) with restart recovery.
- Sub-agent runtime wiring in both:
  - single-agent `/api/chat`
  - squad worker execution in `SquadOrchestrator`

## Design notes

- V2 is native-tool-call first. No plain-text JSON tool-call parser path is used by the runtime.
- Tool result feedback is sent as true `tool` role messages in provider adapters.
- Sub-agent execution is recursively supported with depth controls.
- Run metadata is persisted to disk by default. For distributed deployment, replace queue + store with shared infrastructure.

## Runtime configuration

Configure with environment variables:

- `SUBAGENT_MAX_DEPTH`
- `SUBAGENT_MAX_CONCURRENCY`
- `SUBAGENT_MAX_ACTIVE_RUNS_PER_PARENT`
- `SUBAGENT_DEFAULT_TIMEOUT_MS`
- `SUBAGENT_MAX_TIMEOUT_MS`
- `SUBAGENT_MAX_TASK_CHARS`
- `SUBAGENT_MAX_OUTPUT_CHARS`
- `SUBAGENT_RUN_RETENTION_MS`
- `SUBAGENT_MAX_LISTED_RUNS`
- `SUBAGENT_STORE_MODE` (`file` or `memory`)
- `SUBAGENT_STORE_PATH`
- `RUNTIME_ADMIN_TOKEN` (required for runtime ops in production)

## Ops endpoint

- `GET /api/runtime/subagents?runId=<id>`
- `GET /api/runtime/subagents?runId=<id>&parentRunId=<id>&waitMs=<n>`
- `GET /api/runtime/subagents?parentRunId=<id>&limit=<n>`
- `POST /api/runtime/subagents` with body `{ "action": "cancel", "runId": "...", "parentRunId?": "...", "reason?": "..." }`

Runtime ops auth:

- Header `Authorization: Bearer <RUNTIME_ADMIN_TOKEN>` or `x-runtime-token: <RUNTIME_ADMIN_TOKEN>`.
