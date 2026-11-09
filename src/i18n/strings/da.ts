import type { StringKey } from "./en";

/**
 * Danish string pack. Keys must mirror `en.ts` exactly — TypeScript enforces this via
 * the `Record<StringKey, string>` annotation.
 */
export const da: Record<StringKey, string> = {
    // ── shared / errors ───────────────────────────────────────────────────────
    "error.guildOnly": "Denne kommando kan kun bruges i en server.",
    "error.unknownSubcommand": "Ukendt underkommando: {sub}",
    "error.generic": "Der gik noget galt under håndteringen af den kommando.",
    "error.noLlmConfig":
        "🔑 Denne server har ikke konfigureret en LLM endnu. En admin skal køre `/config api-key` først.",

    // ── /catchup ──────────────────────────────────────────────────────────────
    "catchup.cmd.description": "Opsummér aktiviteten i denne kanal.",
    "catchup.opt.hours": "Hvor mange timer tilbage (standard {default}).",
    "catchup.title": "Catchup — sidste {hours}t",
    "catchup.empty": "Ingen beskeder fundet i de sidste {hours}t for denne kanal.",
    "catchup.indexing": "Indeksering i gang",
    "catchup.indexingBody":
        "Historik bliver stadig indekseret ({count} chunk(s) i baggrundskøen). Kør /catchup igen om ~30s for det fulde billede.",
    "catchup.field.decisions": "Beslutninger ({count})",
    "catchup.field.tasks": "Opgaver ({count})",
    "catchup.field.openQuestions": "Åbne spørgsmål ({count})",
    "catchup.summary.empty": "_Ingen nævneværdig aktivitet._",

    // ── /ask ──────────────────────────────────────────────────────────────────
    "ask.cmd.description": "Stil et spørgsmål om kanalens gemte kontekst.",
    "ask.opt.question": "Dit spørgsmål.",
    "ask.empty": "Jeg har ingen gemt kontekst for denne kanal endnu.",
    "ask.title": "Svar",
    "ask.field.question": "Spørgsmål",
    "ask.field.sources": "Kilder",
    "ask.answer.empty": "_Intet svar genereret._",

    // ── /decisions ────────────────────────────────────────────────────────────
    "decisions.cmd.description": "Vis nyligt fangede beslutninger på denne server.",
    "decisions.opt.channelOnly": "Vis kun beslutninger fra denne kanal.",
    "decisions.opt.includeSuperseded": "Inkludér beslutninger der er blevet erstattet (standard false).",
    "decisions.opt.limit": "Hvor mange skal vises (standard {default}, max 25).",
    "decisions.empty.server": "Ingen beslutninger gemt for denne server endnu.",
    "decisions.empty.channel": "Ingen beslutninger gemt for denne kanal endnu.",
    "decisions.title.server": "Beslutninger — denne server",
    "decisions.title.channel": "Beslutninger — denne kanal",

    // ── /tasks ────────────────────────────────────────────────────────────────
    "tasks.cmd.description": "Vis nyligt fangede opgaver på denne server.",
    "tasks.title": "Opgaver",

    // ── /watch ────────────────────────────────────────────────────────────────
    "watch.cmd.description": "Konfigurér hvilke kanaler ContextBot analyserer.",
    "watch.added":
        "✅ Analyserer nu <#{channelId}>. Beslutninger, opgaver og åbne spørgsmål bliver fanget automatisk.",
    "watch.notWatched": "<#{channelId}> blev ikke overvåget.",
    "watch.removed": "🛑 Stoppede med at analysere <#{channelId}>.",
    "watch.list.empty":
        "Ingen kanaler bliver overvåget endnu. Brug `/watch add` (i en hvilken som helst kanal) for at starte analysen der.",
    "watch.list.title": "Overvågede kanaler",
    "watch.list.footer": "{count} kanal(er)",

    // ── /config ───────────────────────────────────────────────────────────────
    "config.cmd.description": "Konfigurér ContextBots LLM-udbyder for denne server.",
    "config.show.title": "ContextBot — LLM-konfiguration",
    "config.show.empty":
        "Ingen API-nøgle sat endnu. Kør `/config api-key` (kun admin) for at tilføje en OpenAI eller OpenAI-kompatibel nøgle.",
};
