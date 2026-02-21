# CatGPT

CatGPT is a local-first, multi-agent chat workspace built on Next.js. You can create and edit your 'Litter' (agents), assemble collaborative 'Squads', run tool-enabled workflows, and optionally use voice input/output.

## Current State (Repo Snapshot)
- Multi-provider LLM routing: Groq, OpenAI, Anthropic, Google Gemini
- Dynamic model catalog fetching from provider APIs with local cache fallback
- Squad orchestration with a sub-agent runtime (`subagents`)
- Squad blueprint library with import/export JSON support
- Slash command support for generation flows (`/create_cats`, `/create_squad`)
- Context-management safeguards in agent runtime:
  - context window guards
  - turn-boundary history compaction with staged summaries
  - head/tail preservation for oversized messages
  - orphaned tool-call result repair
- Voice stack:
  - TTS: Groq, Edge, ElevenLabs, browser fallback
  - STT: Groq Whisper API + browser speech fallback in UI
- Persisted user settings API (`/api/user-settings`) currently used for UI sidebar width

## Core Features
## Core Features & Real-World Use Cases

- **Single-Agent Chat & Squad Chat**
  - *Use Case 1*: Brainstorming with a single AI agent to draft a blog post, summarize research, or debug code.
  - *Use Case 2*: Assemble a squad (e.g., "App Forge Crew") to collaboratively design, build, and test a new app, with each agent acting as architect, developer, QA, and PM—each with their own role and expertise.
  - *Use Case 3*: Run a "live campaign" squad for creative writing, where each agent role-plays a character in a story, and the user interacts with the whole cast in turn-based chat.

- **Agent Editor**
  - *Use Case 1*: Create a "Data Analyst Cat" agent with access to web search and shell tools, set its style to "expert," and configure it to use a specific LLM provider for advanced data queries.
  - *Use Case 2*: Enable voice output for a "Narrator Cat" agent, choosing a custom TTS voice for accessibility or presentation.
  - *Use Case 3*: Set up an agent to self-evolve, capturing persistent memory and skill snapshots for long-running research or project management tasks.

- **Squad Editor & Blueprints**
  - *Use Case 1*: Import a "Web Launch Pod" blueprint to instantly spin up a team for a website launch, including UX, frontend, backend, and QA agents, each with tailored prompts and tool access.
  - *Use Case 2*: Export a custom squad as a JSON blueprint to share with teammates or reuse in future projects.
  - *Use Case 3*: Use the squad editor to define a product design studio, balancing user research, UX, and engineering feasibility for a new product spec.

- **Interaction Modes**
  - *Master Log*: Run a squad autonomously to deliver a full implementation plan or codebase, with a traceable log of each agent’s contributions.
  - *Live Campaign*: Use turn-based, in-chat squad interaction for collaborative storytelling, D&D sessions, or stepwise project delivery, with typewriter and audio playback for immersion.

- **Tool-Enabled Workflows**
  - *Use Case 1*: Give an agent shell access to automate file operations, run scripts, or validate code on your local machine (with permission controls).
  - *Use Case 2*: Use the web search tool to have an agent gather up-to-date information, compare competitors, or summarize news.
  - *Use Case 3*: Leverage the subagents tool to delegate subtasks (e.g., "generate test cases" or "fetch data") to autonomous sub-agents, with full run management (spawn, await, list, cancel).

- **Voice Stack (TTS & STT)**
  - *Use Case 1*: Dictate messages to agents using voice input (STT), ideal for hands-free operation or accessibility.
  - *Use Case 2*: Enable TTS for agents to read responses aloud, useful for presentations, accessibility, or multitasking.
  - *Use Case 3*: Assign different voices to squad members for a more engaging, character-driven chat experience.

- **Self-Evolving Agents & Memory**
  - *Use Case 1*: Enable persistent memory for a "Research Cat" agent to accumulate knowledge and context over weeks, supporting long-term projects.
  - *Use Case 2*: Schedule autonomous evolution runs for agents to reflect, update skills, and adapt to new requirements without manual intervention.

- **Conversation Management**
  - *Use Case 1*: Save, rename, and revisit conversations with agents or squads, maintaining context for ongoing projects or support tickets.
  - *Use Case 2*: Override models or settings per conversation for targeted experiments or A/B testing.

- **Debug Logging & Runtime Inspector**
  - *Use Case 1*: Enable debug logs to trace API requests and agent reasoning for troubleshooting or transparency.
  - *Use Case 2*: Use the Runtime Inspector panel to monitor agent state, scheduler tasks, and system metrics in real time—essential for advanced users and developers.

- **Skill Import & Management**
  - *Use Case 1*: Import new skills (tool definitions, workflows) from markdown or JSON to extend agent capabilities for specialized domains.
  - *Use Case 2*: Attach custom skills to agents for unique workflows, such as data scraping, report generation, or integration with external APIs.

- **Scheduler & Autonomous Ops**
  - *Use Case 1*: Set up scheduled tasks for agents (e.g., daily report generation, periodic data sync) using the Scheduler panel.
  - *Use Case 2*: Monitor and manage all scheduled and running tasks, including error handling and manual triggers.

---
These examples reflect the real, practical workflows enabled by CatGPT’s current architecture. For more, see the built-in squad blueprints and try combining features for your own use cases.
- `web_search` uses live DuckDuckGo Instant Answer API and may return limited/noisy results for some queries.
- `/api/tts` with `provider: "openai"` is not implemented yet (returns `501`).
- `/api/stt` currently forwards to Groq Whisper only.
- File and shell tools run server-side and are powerful by design; treat this as local/dev tooling unless you add stronger isolation/auth.

## Tech Stack
- Next.js 16 (App Router)
- React 19
- TypeScript
- Tailwind CSS 4
- Framer Motion
- Provider SDKs:
  - `groq-sdk`
  - `openai`
  - `@anthropic-ai/sdk`
  - `@google/generative-ai`
  - `@elevenlabs/elevenlabs-js`

## Quick Start
1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` (or use system ENV vars, or in app API Settings UI to write keys server-side):

   ```bash
   GROQ_API_KEY=
   OPENAI_API_KEY=
   ANTHROPIC_API_KEY=
   GEMINI_API_KEY=
   ELEVENLABS_API_KEY=
   ```

3. Start development server:

   ```bash
   npm run dev
   ```

4. Open:

   ```text
   http://localhost:3000
   ```

Node.js 20+ is recommended for Next.js 16.

## Environment Variables
### Provider/API Keys

| Variable | Used by | Required |
| --- | --- | --- |
| `GROQ_API_KEY` | Groq chat, Groq STT, Groq TTS | Optional (required if using Groq paths) |
| `OPENAI_API_KEY` | OpenAI chat/models | Optional |
| `ANTHROPIC_API_KEY` | Anthropic chat/models | Optional |
| `GEMINI_API_KEY` | Google Gemini chat/models | Optional |
| `ELEVENLABS_API_KEY` | ElevenLabs voices + ElevenLabs TTS | Optional |

### Runtime/Sub-agent Config

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUBAGENT_MAX_DEPTH` | `3` | Max recursive spawn depth |
| `SUBAGENT_MAX_CONCURRENCY` | `3` | Concurrent sub-agent runs |
| `SUBAGENT_MAX_ACTIVE_RUNS_PER_PARENT` | `12` | Active run cap per parent run |
| `SUBAGENT_DEFAULT_TIMEOUT_MS` | `120000` | Default wait timeout |
| `SUBAGENT_MAX_TIMEOUT_MS` | `600000` | Hard timeout cap |
| `SUBAGENT_MAX_TASK_CHARS` | `12000` | Max task input size |
| `SUBAGENT_MAX_OUTPUT_CHARS` | `80000` | Max stored output size |
| `SUBAGENT_RUN_RETENTION_MS` | `86400000` | Finished run retention window |
| `SUBAGENT_MAX_LISTED_RUNS` | `100` | Max runs returned by list ops |
| `SUBAGENT_STORE_MODE` | `file` | `file` or `memory` |
| `SUBAGENT_STORE_PATH` | `data/subagent-runs.json` | File store path |
| `RUNTIME_ADMIN_TOKEN` | unset | Required in production for runtime ops endpoint |
| `MCP_INCLUDE_REASONING_TOOLS` | `0` | Set `1` to include `mcp-sequential-thinking` tools in `mcp_all` |

## NPM Scripts
- `npm run dev` - Start dev server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint
- `npm run test` - Run runtime/unit tests (Vitest)
- `npm run test:watch` - Run Vitest in watch mode

## Architecture and Contributor Docs
- `docs/agentic-runtime-v2.md` - End-to-end v2 runtime architecture, permissions model, sub-agent runtime, and step-by-step guide for adding new agent skills/tools.
- `src/lib/core/tooling/README.md` - Canonical tool model and provider adapter notes.
- `src/lib/core/runtime/README.md` - Runtime v2 and sub-agent runtime reference.

## API Surface

| Route | Method(s) | Purpose |
| --- | --- | --- |
| `/api/chat` | `POST` | Main chat entrypoint (single-agent + squad) |
| `/api/agents/create-cats` | `POST` | Generate agent definitions from natural language |
| `/api/agents/generate-instructions` | `POST` | Generate system prompt text for an agent |
| `/api/llm/models` | `GET` | Provider model catalog (`?refresh=1`, `?probe=1`) |
| `/api/mcp/services` | `GET` | List local MCP services, status, and MCP JSON schema |
| `/api/settings` | `GET`, `POST` | Read/write server key configuration state |
| `/api/user-settings` | `GET`, `PATCH` | Read/update persisted user settings |
| `/api/tts` | `POST` | Text-to-speech generation |
| `/api/stt` | `POST` | Speech-to-text transcription |
| `/api/elevenlabs/voices` | `GET` | ElevenLabs voice list (`?refresh=1`) |
| `/api/runtime/subagents` | `GET` | Inspect/await/list sub-agent runs |
| `/api/runtime/state` | `GET` | Runtime state snapshot/replay stream (`channel`, `runId`, `agentId`, `since`, `stream=1`) |
| `/api/runtime/tasks` | `GET`, `POST` | Scheduler task inspection and control (`enqueue`, `cancel`, `repair`) |
| `/api/runtime/observability` | `GET`, `POST` | Runtime counters + scheduler/state metrics, and clear action |
| `/api/evolution/status` | `POST` | Read evolving memory/profile status for an agent |
| `/api/evolution/run` | `POST` | Trigger a manual autonomous evolution run |
| `/api/evolution/heartbeat` | `POST` | Execute due scheduled evolution runs |

Notable request headers:
- `x-api-keys`: JSON map of provider keys for local/session overrides
- `x-debug-logs: 1`: enable server debug logs for that request
- `x-squad-stream: 1`: NDJSON squad step streaming on `/api/chat`

## Built-in Agent Tools

| Tool ID | Purpose |
| --- | --- |
| `web_search` | Internet search (live DuckDuckGo Instant Answer API) |
| `shell_execute` | Execute shell commands |
| `mcp_all` | Enable all locally configured MCP tools for an agent (includes filesystem tools from MCP) |
| `subagents` | Manage sub-agent runs (`spawn`, `await`, `list`, `cancel`) |

### Access Permission Modes
Agents and squads support two access modes for privileged tools (`mcp_all`, `shell_execute`):
- `ask_always` (default): prompt user each turn before privileged execution
- `full_access`: execute privileged tools without per-turn prompt

Note: squads created via `/create_squad` default to `full_access` + higher iteration budget for autonomous implementation workflows.

Runtime enforcement is server-side in addition to UI prompts.

## Data and Persistence
### Server-side files/directories
- `.env` (provider keys, when saved via API/UI)
- `.cache/llm-model-catalog.json` (model catalog cache)
- `.cache/elevenlabs-voices.json` (voices cache)
- `data/user-settings.json` (user settings)
- `data/subagent-runs.json` (sub-agent runtime store in file mode)
- `data/evolution/agents/<agent-id>/...` (`SOUL.md`, `MEMORY.md`, daily memory logs, profile, and skill snapshots)
- `public/audio/*` (generated/cached audio files)

### Browser localStorage (client-side)
- conversations
- chat and squad agent lists
- squad definitions and saved blueprints
- API key overrides
- model catalog cache
- audio preferences
- debug toggle

### Tool-scoped workspace dirs
Filesystem operations are provided by MCP filesystem tools and are scoped to the MCP service root (default: current workspace `.`).
Squad prompts still direct artifact output under:
- `Squads/<squad-name>/...`

## Project Layout
- `src/app` - App Router pages + API routes
- `src/components` - Chat, settings, agent, and squad UI
- `src/hooks` - Client state hooks (settings, model catalog, audio, user settings)
- `src/lib/core` - Agent runtime, squads, tooling, sub-agent runtime
- `src/lib/llm` - Provider registry/clients + model capability logic
- `src/lib/tools` - Tool implementations (shell, web, sessions)
- `src/lib/squads` - Blueprint parsing/serialization/instantiation
- `src/lib/templates` - Default agents + default squad blueprints

## Security Notes
- Runtime ops endpoints are open by default in non-production if `RUNTIME_ADMIN_TOKEN` is unset:
  - `/api/runtime/subagents`
  - `/api/runtime/state`
  - `/api/runtime/tasks`
  - `/api/runtime/observability`
- In production, set `RUNTIME_ADMIN_TOKEN` and send it via:
  - `Authorization: Bearer <token>`
  - or `x-runtime-token: <token>`
- Runtime Inspector can optionally send `x-runtime-token` from browser localStorage key:
  - `cat_gpt_runtime_admin_token`
- Do not expose this app to untrusted users without adding stronger auth/sandbox controls around shell/filesystem tooling.

## License
Apache License 2.0
