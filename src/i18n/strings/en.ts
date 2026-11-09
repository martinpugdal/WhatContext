/**
 * English string pack — the source of truth for translation keys.
 * `da.ts` (and any future locale) must implement the same keys.
 *
 * Use {placeholder} syntax for runtime substitutions; `t()` replaces them.
 */
export const en = {
    // ── shared / errors ───────────────────────────────────────────────────────
    "error.guildOnly": "This command can only be used in a server.",
    "error.unknownSubcommand": "Unknown subcommand: {sub}",
    "error.generic": "Something went wrong handling that command.",
    "error.noLlmConfig":
        "🔑 This server has no LLM configured yet. An admin needs to run `/config api-key` first.",

    // ── /catchup ──────────────────────────────────────────────────────────────
    "catchup.cmd.description": "Summarize recent activity in this channel.",
    "catchup.opt.hours": "How many hours back to look (default {default}).",
    "catchup.title": "Catchup — last {hours}h",
    "catchup.empty": "No stored messages found in the last {hours}h for this channel.",
    "catchup.indexing": "Indexing in progress",
    "catchup.indexingBody":
        "History is still being indexed ({count} chunk(s) queued in the background). Re-run /catchup in ~30s for the full picture.",
    "catchup.field.decisions": "Decisions ({count})",
    "catchup.field.tasks": "Tasks ({count})",
    "catchup.field.openQuestions": "Open questions ({count})",
    "catchup.summary.empty": "_No notable activity._",

    // ── /ask ──────────────────────────────────────────────────────────────────
    "ask.cmd.description": "Ask a question about this channel's stored context.",
    "ask.opt.question": "Your question.",
    "ask.empty": "I don't have any stored context for this channel yet.",
    "ask.title": "Answer",
    "ask.field.question": "Question",
    "ask.field.sources": "Sources",
    "ask.answer.empty": "_No answer generated._",

    // ── /decisions ────────────────────────────────────────────────────────────
    "decisions.cmd.description": "List recent decisions captured in this server.",
    "decisions.opt.channelOnly": "Only show decisions from this channel.",
    "decisions.opt.includeSuperseded": "Include decisions that have been superseded (default false).",
    "decisions.opt.limit": "How many to show (default {default}, max 25).",
    "decisions.empty.server": "No decisions saved for this server yet.",
    "decisions.empty.channel": "No decisions saved for this channel yet.",
    "decisions.title.server": "Decisions — this server",
    "decisions.title.channel": "Decisions — this channel",

    // ── /tasks ────────────────────────────────────────────────────────────────
    "tasks.cmd.description": "List recent tasks captured in this server.",
    "tasks.title": "Tasks",

    // ── /watch ────────────────────────────────────────────────────────────────
    "watch.cmd.description": "Configure which channels ContextBot analyzes.",
    "watch.added": "✅ Now analyzing <#{channelId}>. Decisions, tasks and open questions will be captured automatically.",
    "watch.notWatched": "<#{channelId}> wasn't being watched.",
    "watch.removed": "🛑 Stopped analyzing <#{channelId}>.",
    "watch.list.empty":
        "No channels are being watched yet. Use `/watch add` (in any channel) to start analysis there.",
    "watch.list.title": "Watched channels",
    "watch.list.footer": "{count} channel(s)",

    // ── /config ───────────────────────────────────────────────────────────────
    "config.cmd.description": "Configure ContextBot's LLM provider for this server.",
    "config.show.title": "ContextBot — LLM config",
    "config.show.empty":
        "No API key set yet. Run `/config api-key` (admin only) to add an OpenAI or OpenAI-compatible key.",
} as const;

export type StringKey = keyof typeof en;
