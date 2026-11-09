# WhatContext

A Discord bot that turns channel activity into project memory. It captures messages from watched channels, extracts decisions, tasks, and open questions, and helps teams catch up or ask questions against stored context.

## Screenshots

| Catchup summary | Context Q&A |
|---|---|
| ![Catchup summary](docs/screenshots/01-catchup-summary.png) | ![Context Q&A](docs/screenshots/02-context-qa.png) |

| Decisions & tasks | Server setup & config |
|---|---|
| ![Decisions and tasks](docs/screenshots/03-decisions-tasks.png) | ![Server setup and config](docs/screenshots/04-server-setup-config.png) |

## Features

- **Per-channel watch list**: choose which channels are analyzed with `/watch`.
- **Message analysis**: stores messages and extracts project signal (decisions, tasks, open questions) when importance is medium or high.
- **Catch-up summaries**: `/catchup` summarizes recent channel activity using cached digest chunks for longer windows.
- **Context Q&A**: `/ask` answers questions grounded in recent messages, summaries, decisions, and tasks.
- **Decision/task/question management**: commands for listing and updating captured items.
- **Bring your own LLM key**: per-guild OpenAI or OpenAI-compatible API configuration via `/config` (keys encrypted at rest).
- **Local dev fallback**: optional Ollama fallback when `DEV_LOCAL_FALLBACK=true`.

## Stack

- TypeScript + Node.js (>= 18.17)
- discord.js v14
- PostgreSQL + Prisma
- OpenAI-compatible chat completions / optional local Ollama

## Project structure

```text
src/
  bot.ts                 # Discord client entry point
  deploy-commands.ts     # Slash command registration
  commands/              # Slash command handlers
  services/              # AI, message ingestion, digests, command loading
  db/                    # Prisma client
  config/                # Environment validation
  i18n/                  # Localized strings
prisma/
  schema.prisma          # Database schema
  migrations/            # Prisma migrations
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and set the required values:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_DEV_GUILD_ID=

DATABASE_URL=postgresql://user:password@localhost:5432/contextbot?schema=public
CRYPTO_KEY=

# Optional local Ollama settings
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_FAST_MODEL=qwen2.5:1.5b

# Optional defaults
OPENAI_DEFAULT_MODEL=gpt-4o-mini
ANALYZE_DEBOUNCE_MS=5000
DEV_LOCAL_FALLBACK=false
```

Generate `CRYPTO_KEY` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 3. Set up the database

```bash
npm run prisma:migrate
```

### 4. Register slash commands

```bash
npm run commands:deploy
```

If `DISCORD_DEV_GUILD_ID` is set, commands register to that guild immediately. Without it, global registration can take time to propagate.

### 5. Run the bot

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Discord setup

In the Discord Developer Portal:

- Enable **Message Content Intent**.
- Invite the bot with `bot` and `applications.commands` scopes.
- Grant permissions to view channels, read message history, and send messages in channels you want it to use.

## Usage

1. Add channels to analyze: `/watch add #channel`
2. Configure an LLM provider for the guild: `/config api-key`
3. Use `/catchup`, `/ask`, `/decisions`, `/tasks`, and related commands.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run with ts-node + nodemon |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run prisma:migrate` | Apply/create Prisma migrations in development |
| `npm run prisma:generate` | Regenerate Prisma client |
| `npm run commands:deploy` | Register Discord slash commands |

## Notes

- AI context is truncated to keep prompts within model limits.
- Very short messages are stored but not analyzed.
- `DEV_LOCAL_FALLBACK` is for local development only. Production guilds should configure their own API key.
- Do not commit `.env`; it may contain Discord credentials and encryption keys.
