# CatGPT

CatGPT is a local-first, multi-agent chat workspace built on Next.js. You can create and edit your 'Litter' (agents), assemble collaborative 'Squads', run tool-enabled workflows, and optionally use voice input/output.

## Current State (Repo Snapshot)
This codebase now supports much more than the original single-provider setup:

- Multi-provider LLM routing: Groq, OpenAI, Anthropic, Google Gemini
- Dynamic model catalog fetching from provider APIs with local cache fallback
- Squad orchestration with a sub-agent runtime (`sessions_spawn`, `sessions_await`, `sessions_list`)
- Squad blueprint library with import/export JSON support
- Slash command support for generation flows (`/create_cats`, `/create_squad`)
- Voice stack:
  - TTS: Groq, Edge, ElevenLabs, browser fallback
  - STT: Groq Whisper API + browser speech fallback in UI
- Persisted user settings API (`/api/user-settings`) currently used for UI sidebar width

## Core Features
- Single-agent chat and squad chat from one interface
- Agent editor for:
  - Identity, role, style, and instructions
  - Provider/model selection
  - Reasoning effort selection (`none|low|medium|high`) when model supports it
  - Voice provider + voice selection
  - Tool enablement per agent
- Squad editor with interaction modes:
  - `master_log`: autonomous worker execution with orchestration trace panel
  - `live_campaign`: in-chat worker turns with sequenced typewriter/audio playback (chat live with your team tfor more a collaborative working style)
- Conversation persistence with rename/delete and per-conversation model overrides
- Debug logging toggle (adds `x-debug-logs: 1` to API requests)

## Important Limitations (As Implemented)
- `web_search` tool is currently a mock/stub response, not a real search provider integration.
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

## NPM Scripts
- `npm run dev` - Start dev server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

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

Notable request headers:
- `x-api-keys`: JSON map of provider keys for local/session overrides
- `x-debug-logs: 1`: enable server debug logs for that request
- `x-squad-stream: 1`: NDJSON squad step streaming on `/api/chat`

## Built-in Agent Tools

| Tool ID | Purpose |
| --- | --- |
| `web_search` | Internet search (currently mock output) |
| `fs_read` | Read file contents |
| `fs_write` | Write/append file contents with safeguards |
| `fs_list` | List directory contents |
| `shell_execute` | Execute shell commands |
| `mcp_all` | Enable all locally configured MCP tools for an agent |
| `sessions_spawn` | Spawn sub-agent task |
| `sessions_await` | Wait for sub-agent run |
| `sessions_list` | List sub-agent runs |
| `sessions_cancel` | Cancel sub-agent runs |

### Access Permission Modes
Agents and squads support two access modes for privileged tools (`fs_write`, `shell_execute`):
- `ask_always` (default): prompt user each turn before privileged execution
- `full_access`: execute privileged tools without per-turn prompt

Runtime enforcement is server-side in addition to UI prompts.

## Data and Persistence
### Server-side files/directories
- `.env` (provider keys, when saved via API/UI)
- `.cache/llm-model-catalog.json` (model catalog cache)
- `.cache/elevenlabs-voices.json` (voices cache)
- `data/user-settings.json` (user settings)
- `data/subagent-runs.json` (sub-agent runtime store in file mode)
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
`fs_*` tools default to scoped folders when relative paths are used:
- `Cats/<agent-name>/...`
- `Squads/<squad-name>/...`

## Project Layout
- `src/app` - App Router pages + API routes
- `src/components` - Chat, settings, agent, and squad UI
- `src/hooks` - Client state hooks (settings, model catalog, audio, user settings)
- `src/lib/core` - Agent runtime, squads, tooling, sub-agent runtime
- `src/lib/llm` - Provider registry/clients + model capability logic
- `src/lib/tools` - Tool implementations (filesystem, shell, web, sessions)
- `src/lib/squads` - Blueprint parsing/serialization/instantiation
- `src/lib/templates` - Default agents + default squad blueprints

## Security Notes
- Runtime ops endpoint (`/api/runtime/subagents`) is open by default in non-production if `RUNTIME_ADMIN_TOKEN` is unset.
- In production, set `RUNTIME_ADMIN_TOKEN` and send it via:
  - `Authorization: Bearer <token>`
  - or `x-runtime-token: <token>`
- Do not expose this app to untrusted users without adding stronger auth/sandbox controls around shell/filesystem tooling.

## License
Apache License 2.0
