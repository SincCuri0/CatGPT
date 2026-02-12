# CatGPT

CatGPT is a multi-agent, cat-themed chat workspace built on Next.js. Create and customize a "litter" of agents, keep separate chat histories per agent, and optionally enable voice (TTS/STT) for a more hands-free experience. The backend supports tool-augmented responses (filesystem, shell, web search) to enable agent workflows.

## Features
- Multi-agent chat with editable personalities and roles
- Conversation history with rename/delete and time-based grouping
- Settings modal to manage your Groq API key
- Optional TTS (Groq Orpheus or Edge) and STT (Groq Whisper)
- Tool registry for filesystem, shell, and web search actions

## Tech Stack
- Next.js 16 (App Router)
- React 19
- Tailwind CSS 4
- Groq API (LLM + STT + optional TTS)

## Quick Start
1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure your API key:
   - Create a `.env` file with:
     ```bash
     GROQ_API_KEY=your_key_here
     ```
   - Or set it in the UI via Settings (writes to `.env`).

3. Run the dev server:
   ```bash
   npm run dev
   ```

Open `http://localhost:3000`.

## Scripts
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Run production server
- `npm run lint` - Lint the codebase

## Project Structure
- `src/app` - Next.js routes, including API endpoints
- `src/components` - UI components (chat, agents, settings)
- `src/lib` - Core agent logic, tools, audio helpers
- `public/audio` - Generated audio output

## Notes on Tools and Security
Server-side tools include filesystem access, shell execution, and web search. This is intended for local development and controlled environments. Do not deploy these tools to untrusted environments without additional auth, sandboxing, and validation.

## License
TBD
