# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Development mode with hot reload (tsx watch)
npm run build    # Compile TypeScript → dist/
npm start        # Run compiled output from dist/index.js
```

No linting or test suite is configured.

## Environment Setup

Copy `.env.example` and fill in the required variables:

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq LLM API key |
| `TENANT_BOT_TOKEN` | Telegram bot token |
| `DATABASE_URL` | PostgreSQL connection string |
| `API_URL` | Backend REST API (default `http://localhost:3000`) |
| `MCP_URL` | MCP HTTP server (default `http://localhost:3000/mcp`) |
| `MCP_SHARED_SECRET` | Shared secret for MCP auth header |

`NODE_ENV=development` uses an in-memory LangGraph checkpointer; production uses the PostgreSQL saver.

## Architecture Overview

This is a **Telegram chatbot for kosan (boarding house) rental management**. The core is a **LangGraph multi-agent state machine** that processes messages from Telegram users and calls a backend via MCP tools.

### Request Flow

```
Telegram message
  → Telegraf bot handler (src/bot/)
  → LangGraph graph.stream() invocation (src/graph/graph.ts)
      ├── memory node       → load user context from PostgreSQL
      ├── vision node       → analyze attached images with Llama 4 Vision
      ├── supervisor node   → route intent to an agent or clarification
      ├── agent nodes       → general / profile / rooms / payments
      ├── tool node         → MCP HTTP calls (with auth header injection)
      ├── confirmation node → ask user to confirm destructive actions
      └── clarification node→ ask for missing info before proceeding
  → stream response back to Telegram
```

### Key Directories

- **`src/bot/`** — Telegraf handlers for text and photo messages; assembles the initial `HumanMessage` with image URL if present.
- **`src/graph/`** — All LangGraph nodes (`nodes/`), edge routing logic (`edges/`), graph assembly (`graph.ts`), and shared state schema (`state.ts`).
- **`src/prompts/`** — System prompt strings (`index.ts`) and a runtime context builder (`context.ts`) that injects user profile, active rentals, and pending payments into prompts.
- **`src/mcp/`** — MCP client setup (`client.ts`) and an auth adapter (`auth-adapter.ts`) that injects `x-shared-secret` and `x-user-id` into every tool call.
- **`src/memory/`** — PostgreSQL-backed long-term memory: fact extraction, episodic summarization, retrieval by embedding similarity, and periodic compaction.
- **`src/llm/`** — Groq model instances: default text model, supervisor/router model, and vision model.
- **`src/lib/`** — Shared utilities: structured logger (Pino), message formatters, embedding helper, and timezone-aware date utilities.
- **`src/config/`** — Memory configuration: fact categories and extraction thresholds.

### State Schema (`src/graph/state.ts`)

The `GraphAnnotation` holds per-conversation state across LangGraph nodes:
- `messages` — full LangChain message history with a reducer
- `memoryContext`, `episodicMemory` — retrieved long-term context
- `pendingAction`, `pendingClarification` — pending confirmation/clarification payloads
- `activePaymentId`, `pendingPaymentsSnapshot` — payment workflow tracking
- `longTermMemoryCandidates` — facts queued for storage

### Agent Routing

The supervisor node routes to one of four domain agents:
- **general** — FAQ, general questions, memory search
- **profile** — User profile CRUD
- **rooms** — Room search, availability, rental creation
- **payments** — Payment submission, proof image validation

Each agent calls MCP tools. Tool results may contain image URLs which are extracted by the media extractor node and sent as separate Telegram messages.

### MCP Tool Auth Pattern

Every MCP tool invocation is wrapped by `src/mcp/auth-adapter.ts`, which adds `x-shared-secret` and `x-user-id` headers so the backend can authenticate the bot and identify the acting user without the agent needing to pass credentials explicitly.

### Models Used

| Role | Model |
|---|---|
| Default reasoning | `llama-3.3-70b-versatile` |
| Supervisor/router | `openai/gpt-oss-120b` (via Groq) |
| Vision/image analysis | `meta-llama/llama-4-scout-17b-16e-instruct` |
