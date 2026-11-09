# ContextBot — Roadmap

A living list of ideas and improvements considered for ContextBot. Items move from
**Backlog** → **Recommended next** → **Done** as we work through them.

## ✅ Already shipped (in this session)

- Per-guild BYOK with AES-256-GCM-encrypted keys (`/config api-key` modal)
- Support for any OpenAI-compatible provider (Groq, OpenRouter, DeepSeek, …) via base URL
- Map-reduce digest with cached chunk summaries, lazy + worker pre-build
- DB as single source of truth for Decisions / Tasks / Open Questions in `/catchup`
- Chunk-level extraction of multi-message decisions (AI dedups against per-message extractions)
- `/decision supersede`, `/decision restore`, `/question resolve`, `/question reopen`
- `/task done`, `/task cancel`, `/task assign`, `/task list` (with id autocomplete)
- `/watch add | remove | list` with cached allow-list, invalidated on writes
- i18n infrastructure (`src/i18n/`) — type-safe da/en string packs, `setDescriptionLocalizations` on slash commands
- Per-guild output language override (`/config language` → injected as system-prompt override)
- `messageUpdate` and `messageDelete` event handling (Decision rows survive deleted source messages via `onDelete: SetNull`)
- Dev-only Ollama fallback (`DEV_LOCAL_FALLBACK=true`) so local development doesn't need a key

---

## 🔜 Recommended next

These are the highest portfolio-value-per-hour items. Pick one when you have time.

### `/admin backfill` — slurp Discord history into the bot

**Why**: Right now ContextBot is blind to anything that happened before it joined or before
a channel was added to `/watch`. An admin command to fetch the last N hours of channel
history through the Discord REST API and feed each message through the existing ingest
pipeline removes the worst onboarding pothole.

**Touches**: a new `src/commands/admin.ts`; `messageService.ingest` already does the right
thing for synthetic `Message` objects.

**Effort**: small (1-2 hours).

### Embedding-based RAG for `/ask`

**Why**: Today `/ask` dumps the 80 newest messages, all decisions, all tasks, and a few
summaries into the AI prompt. On a channel with 50,000 messages this is wasteful and the
80-msg window misses anything older. Vector embeddings + similarity search would feed only
the 20 most relevant snippets per question.

**Touches**: `pgvector` extension on Postgres, an `Embedding` table linked to `Message` and
to `Summary`, an embed-on-ingest step in `messageService`, a vector search before the AI call
in `ask.ts`. `pg_vector` works fine inside the existing docker-compose Postgres.

**Effort**: medium (half a day). High portfolio appeal — RAG is what every "AI assistant"
demo claims to do; doing it cleanly stands out.

### Web dashboard (Next.js + Discord OAuth)

**Why**: A standalone web UI showing decisions, tasks, open questions and a search field,
with login via Discord OAuth so an admin only sees servers they're a member of. Lifts the
project from "a Discord bot- to "a SaaS prototype".

**Touches**: a sibling Next.js project (`apps/dashboard/`) sharing the Prisma schema, a
Discord OAuth flow, and a thin "list decisions for guild X- API on the bot side (or have
the dashboard talk to Postgres directly with a service-role key).

**Effort**: large (1-3 days). Highest portfolio impact — full-stack, auth, multi-tenant.

### Tests + GitHub Actions CI

**Why**: First thing a reviewer does is open the repo. Seeing tests + a green CI badge
signals quality. `digest.service` and `message.service` have non-trivial invariants
(chunks tile without gaps; debounce coalesces correctly; allow-list cache invalidates) that
would benefit from coverage.

**Touches**: `package.json` test script, `vitest` or `jest`, a few unit tests with mocked
Prisma/AI, `.github/workflows/ci.yml` running `tsc --noEmit`, `npm test`, and `prisma migrate
diff` to catch unmigrated schema drift.

**Effort**: small to medium (2-4 hours).

---

## 💡 Backlog (good ideas, lower priority or niche)

### Workflow features

- **Scheduled digests**: `/digest schedule daily 09:00 #channel` to auto-post a `/catchup`
  every morning. Cron + a tiny `ScheduledDigest` table.
- **Notify on task assignment**: when a Task gets an assignee (per-message AI extraction
  *or* `/task assign`), ping that user in the channel. Lifts the bot from "memory- to
  "lightweight project tool".
- **Export**: `/export format:markdown|json` dumping decisions/tasks/questions/summaries.
  Users want to own their data.
- **Cost tracking on BYOK**: track tokens used per guild from OpenAI's `usage` field, show
  in `/config show` ("This month: 1.2M tokens, ~$0.30").
- **Configurable importance thresholds per channel**: `/watch sensitivity high` so a
  high-volume `#general` only captures HIGH-importance, while `#standups` captures everything.
- **Rate-limit awareness**: per-channel ingest rate limit so one chatty channel can't
  monopolize the serial worker.

### Quality of life

- **Threads as first-class chunks**: today thread messages roll up into the parent channel's
  digest. For some teams threads should be summarized separately.
- **Search/filter on `/decisions`, `/tasks`**: text search, date filters, status filters.
- **Better autocomplete using embeddings**: fuzzy semantic match for `/task done id`,
  `/decision supersede id` so admins can type "postgres- and find "switch DB to Postgres"
  even if it's worded differently.
- **`/help` command**: even with Discord's built-in suggestions, a friendly overview embed
  helps onboarding.
- **Better error messages**: distinguish "rate-limited", "auth failed", "timeout", "model
  not found- instead of returning the raw OpenAI error string.

### Infrastructure / production readiness

- **Encrypted-at-rest message content**: today messages are stored plaintext. Privacy-
  conscious teams may want them encrypted with the existing `CRYPTO_KEY`. Trade-off: search
  becomes harder, embeddings become impossible without decrypt-on-fly.
- **Structured logging**: `pino` with log levels, optional file sink. Useful when running
  on a VPS.
- **Observability**: `/admin status` showing queue depth, last ingest per channel, chunk
  freshness, AI cost so far this month.
- **Backup/restore**: `pg_dump` scripts + a documented restore procedure.
- **CRYPTO_KEY rotation flow**: a one-shot script that re-encrypts all stored API keys with
  a new master key, so admins aren't locked into the first key forever.
- **Multi-language UI beyond da/en**: the i18n infrastructure already supports any locale —
  drop a new file under `src/i18n/strings/` and add an entry in `index.ts`.
- **Tightened cooldowns** on heavy commands (`/catchup`, `/ask`) to prevent abuse.

### Big-picture features

- **Cross-channel digest**: `/digest cross-channel` summarizing across multiple watched
  channels in one server.
- **Notion / Slack push integrations**: when a decision is captured, mirror it to a Notion
  database or post it to a Slack channel. Integrations are expensive to maintain — only do
  if a real user asks.
- **Custom system prompts per guild**: let admins tweak the "extract project signal"
  default. e.g. a marketing team gets "focus on campaign decisions and launch dates".
- **Recursive reduce** for >14-day catchup windows. The `reduceChunks` signature already
  accepts structured chunks, so a chunk-of-chunks layer is a thin wrapper away.

---

## Notes for future you

- The plan files at `~/.claude/plans/` document the design rationale behind shipped
  features — useful when revisiting why a decision was made.
- Existing code patterns to reuse:
  - Modal flow with private input → `src/commands/config.ts`
  - Slash command with id autocomplete → `src/commands/task.ts`
  - Per-guild AI factory with cache invalidation → `src/services/ai.service.ts:aiServiceForGuild`
  - Type-safe localized strings → `src/i18n/strings/en.ts` is the source of truth; `da.ts`
    is enforced by `Record<StringKey, string>`
- Prisma migrations are written manually (Inno-style installers are non-interactive, and
  `prisma migrate dev` blocks on prompts). Pattern: create `prisma/migrations/<timestamp>_<name>/migration.sql`,
  then `npx prisma migrate deploy && npx prisma generate`.
