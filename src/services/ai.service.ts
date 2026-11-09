import { Ollama } from "ollama";
import OpenAI from "openai";
import type { GuildConfig } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import { decrypt } from "../util/crypto";

/**
 * Thrown when a guild has no configured LLM and no dev fallback. Commands should catch this
 * and surface a friendly "run /config api-key- message instead of crashing.
 */
export class NoLlmConfigError extends Error {
    readonly guildId: string;
    constructor(guildId: string) {
        super(
            "No LLM provider configured for this server. An admin needs to run `/config api-key` to add an OpenAI (or OpenAI-compatible) API key.",
        );
        this.name = "NoLlmConfigError";
        this.guildId = guildId;
    }
}

export type Importance = "low" | "medium" | "high";

export interface ExtractedTask {
    title: string;
    assignee: string | null;
    dueDate: string | null;
}

export interface MessageAnalysis {
    importance: Importance;
    decisions: string[];
    tasks: ExtractedTask[];
    openQuestions: string[];
}

export interface ContextMessage {
    authorUsername: string;
    content: string;
    createdAt: Date;
}

export interface ChunkMessage extends ContextMessage {
    importance: "low" | "medium" | "high" | null;
}

export interface ChunkSummary {
    summary: string;
    windowStart: Date;
    windowEnd: Date;
    messageCount: number;
}

/**
 * Output of the catchup reduce step. Decisions/tasks/open-questions are no longer generated
 * here — they're queried from the canonical DB tables in the /catchup command, so the AI's
 * job is just the prose narrative. See plan: spicy-weaving-dusk.md.
 */
export interface CatchupSummary {
    summary: string;
}

/**
 * Output of `summarizeChunk`. The summary is the chunk's prose; the new* fields are items
 * that emerged across messages and weren't already captured per-message. Persisted into the
 * Decision/Task/OpenQuestion tables by digest.service.
 */
export interface ChunkExtractionResult {
    summary: string;
    newDecisions: string[];
    newTasks: ExtractedTask[];
    newOpenQuestions: string[];
}

/**
 * Items already captured (per-message) within the chunk's window. Passed to the AI so it
 * can avoid duplicating them. Strings rather than IDs because the AI only cares about
 * semantic content, not identity.
 */
export interface ExistingExtractions {
    decisions: string[];
    tasks: Array<{ title: string; assignee: string | null }>;
    openQuestions: string[];
}

export interface AnswerCitation {
    discordMessageId?: string;
    snippet: string;
}

export interface AnswerResult {
    answer: string;
    citations: AnswerCitation[];
}

export interface ProviderInfo {
    /** Display label — "OpenAI", "Local (Ollama)", or "OpenAI-compatible (api.example.com)". */
    label: string;
    model: string;
}

const SYSTEM_PROMPT_BASE = `You are ContextBot, a project memory assistant for Discord teams.
Your job is to extract durable project context from chat: decisions made, action items, and open questions.
Rules:
- Only capture things that clearly read as project signal. Ignore small talk, greetings, jokes, and venting.
- Never invent decisions, deadlines, assignees, or tasks. If unsure, return empty arrays.
- A "task- requires a clear action item. Casual ideas ("maybe we could...") are NOT tasks.
- A "decision- is a concrete choice the team has agreed to or stated as final.
- Assignees should be Discord usernames as they appear in the messages, or null if not specified.
- Due dates must be ISO-8601 (YYYY-MM-DD) only when explicitly stated; otherwise null.
- Always respond with valid JSON matching the requested schema. No prose outside JSON.
- LANGUAGE: Write all natural-language strings (summaries, decisions, tasks, openQuestions, answers, snippets) in the SAME language as the input messages. If the input is in Danish, reply in Danish. If mixed, prefer the dominant language. JSON keys, ISdates, and Discord usernames stay as-is.`;

const ANALYZE_SCHEMA_HINT = `{
  "importance": "low" | "medium" | "high",
  "decisions": string[],
  "tasks": [{ "title": string, "assignee": string | null, "dueDate": string | null }],
  "openQuestions": string[]
}`;

const SUMMARY_SCHEMA_HINT = `{
  "summary": string             // 3-6 sentences of narrative prose, plain text, no markdown headings
}`;

const ANSWER_SCHEMA_HINT = `{
  "answer": string,             // concise answer, plain text, no markdown headings
  "citations": [{ "discordMessageId": string | null, "snippet": string }]
}`;

const CHUNK_SCHEMA_HINT = `{
  "summary": string,                 // 2-4 short sentences covering project signal: who decided/asked/committed to what
  "newDecisions": string[],          // decisions emerging across messages NOT in the existing list
  "newTasks": [{ "title": string, "assignee": string | null, "dueDate": string | null }],
  "newOpenQuestions": string[]
}`;

const MIN_ANALYZABLE_LENGTH = 12;
const MAX_CONTEXT_CHARS = 14_000;

/**
 * Backend abstraction: turn a (system, user) prompt pair into a JSON string. Both implementations
 * request JSON-only responses from the model, so callers can `JSON.parse` the result.
 */
interface JsonChatBackend {
    info: ProviderInfo;
    complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

class OllamaBackend implements JsonChatBackend {
    public readonly info: ProviderInfo;
    private client: Ollama;

    constructor(model: string) {
        this.client = new Ollama({ host: env.OLLAMA_BASE_URL });
        this.info = { label: "Local (Ollama)", model };
    }

    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
        const response = await this.client.chat({
            model: this.info.model,
            format: "json",
            stream: false,
            options: { temperature: 0.1 },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
        });
        return response.message?.content ?? "";
    }
}

class OpenAiBackend implements JsonChatBackend {
    public readonly info: ProviderInfo;
    private client: OpenAI;

    constructor(apiKey: string, model: string, baseUrl?: string) {
        // The OpenAI SDK reads OPENAI_API_KEY from env if `apiKey` is omitted; we pass it
        // explicitly so per-guild keys never leak into process.env. baseURL is used to
        // talk to OpenAI-compatible endpoints (Groq, OpenRouter, Together, DeepSeek, etc.).
        this.client = new OpenAI({ apiKey, baseURL: baseUrl });
        const label = baseUrl
            ? `OpenAI-compatible (${humanReadableHost(baseUrl)})`
            : "OpenAI";
        this.info = { label, model };
    }

    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: this.info.model,
            temperature: 0.1,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
        });
        return response.choices[0]?.message?.content ?? "";
    }
}

/**
 * High-level service that wraps a JsonChatBackend with the prompt templates and result
 * sanitisation that ContextBot needs. One instance is created per (guildId, backend config)
 * — the factory caches them so we don't pay the OpenAI client construction cost on every call.
 */
class AiService {
    private backend: JsonChatBackend;
    private fastBackend: JsonChatBackend;
    private systemPrompt: string;

    constructor(backend: JsonChatBackend, options: { fastBackend?: JsonChatBackend; outputLanguage?: string | null } = {}) {
        this.backend = backend;
        this.fastBackend = options.fastBackend ?? backend;
        this.systemPrompt = buildSystemPrompt(options.outputLanguage ?? null);
    }

    get info(): ProviderInfo {
        return this.backend.info;
    }

    async analyzeMessage(content: string): Promise<MessageAnalysis | null> {
        const trimmed = content.trim();
        if (trimmed.length < MIN_ANALYZABLE_LENGTH) return null;

        const userPrompt = `Analyze the following Discord message and classify it.

Return JSON exactly matching this shape:
${ANALYZE_SCHEMA_HINT}

Importance levels:
- "low": small talk, reactions, off-topic, no project signal.
- "medium": notable update, light coordination, useful context.
- "high": clear decision, concrete commitment, blocker, or scheduled work.

Message:
""
${trimmed}
""`;

        const raw = await this.fastBackend.complete(this.systemPrompt, userPrompt);
        const parsed = safeJson<MessageAnalysis>(raw);
        if (!parsed) return null;

        return {
            importance: coerceImportance(parsed.importance),
            decisions: cleanStringArray(parsed.decisions),
            tasks: cleanTaskArray(parsed.tasks),
            openQuestions: cleanStringArray(parsed.openQuestions),
        };
    }

    async summarizeChunk(
        messages: ChunkMessage[],
        existing: ExistingExtractions = { decisions: [], tasks: [], openQuestions: [] },
    ): Promise<ChunkExtractionResult> {
        const empty: ChunkExtractionResult = {
            summary: "",
            newDecisions: [],
            newTasks: [],
            newOpenQuestions: [],
        };
        if (messages.length === 0) return empty;

        const lines = messages.map((m) => {
            const importanceTag = m.importance ? `[${m.importance.toUpperCase()}] ` : "";
            const time = m.createdAt.toISOString().slice(11, 16);
            return `${importanceTag}${m.authorUsername} ${time}: ${m.content}`;
        });
        const transcript = truncate(lines.join("\n"), MAX_CONTEXT_CHARS);

        const existingSection = renderExistingExtractions(existing);

        const userPrompt = `Compress the following Discord excerpt into a project-signal summary AND extract any decisions, tasks, or open questions that emerge across multiple messages but are NOT already in the "existing- list below.

Return JSON exactly matching:
${CHUNK_SCHEMA_HINT}

Rules for "summary- (2-4 sentences):
- Lead with what was decided, who committed to what, and which open questions surfaced.
- Skip greetings, jokes, reactions, and chit-chat unless they're load-bearing.
- The bracketed [HIGH]/[MEDIUM]/[LOW] tags are heuristic hints — trust your own judgment when they look wrong.
- Be specific (names, dates, components) but concise.

Rules for "newDecisions- / "newTasks- / "newOpenQuestions":
- ONLY include items that are NOT semantically equivalent to anything in the "existing- list. The list represents what was already captured per-message; you're catching only multi-message synthesis the per-message extractor missed.
- Same dedup rule applies WITHIN each new array — don't list the same decision twice in different words.
- A "task- requires a clear action item. Casual ideas don't count.
- Do not invent: if you're unsure something is a real decision/task/question, leave it out and let "summary- mention it.
- If nothing new emerges across messages, return empty arrays for the three "new*- fields. That's fine and expected.

Existing extractions for this window (per-message):
${existingSection}

Excerpt:
""
${transcript}
""`;

        const raw = await this.backend.complete(this.systemPrompt, userPrompt);
        const parsed = safeJson<ChunkExtractionResult>(raw);
        if (!parsed) return empty;

        return {
            summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
            newDecisions: cleanStringArray(parsed.newDecisions),
            newTasks: cleanTaskArray(parsed.newTasks),
            newOpenQuestions: cleanStringArray(parsed.newOpenQuestions),
        };
    }

    async reduceChunks(chunks: ChunkSummary[], tail: ContextMessage[]): Promise<CatchupSummary> {
        if (chunks.length === 0 && tail.length === 0) {
            return { summary: "No activity to summarize." };
        }

        const sections: string[] = [];

        if (chunks.length > 0) {
            sections.push("PRIOR CHUNK SUMMARIES (oldest → newest):");
            for (const c of chunks) {
                if (!c.summary) continue;
                const span = `${c.windowStart.toISOString().slice(0, 16)} → ${c.windowEnd.toISOString().slice(0, 16)}`;
                sections.push(`- (${span}, ${c.messageCount} msgs) ${c.summary}`);
            }
            sections.push("");
        }

        if (tail.length > 0) {
            sections.push(`RECENT MESSAGES (after last chunk, ${tail.length} total):`);
            for (const m of tail) {
                sections.push(`${m.authorUsername} ${m.createdAt.toISOString().slice(11, 16)}: ${m.content}`);
            }
        }

        const transcript = truncate(sections.join("\n"), MAX_CONTEXT_CHARS);

        const userPrompt = `Write a narrative summary of the project's activity below. The reader sees decisions, tasks, and open questions in separate database-backed lists alongside this prose, so do NOT enumerate them here.

Return JSON exactly matching:
${SUMMARY_SCHEMA_HINT}

Rules:
- 3-6 sentences of natural prose covering what shifted, what's blocked, and the overall direction.
- The chunk summaries are already compacted — treat them as ground truth.
- Recent messages are raw; weigh them against your usual signal/noise judgment.
- Do NOT format as a bullet list or numbered list. Plain prose only.
- Do NOT echo specific decision/task/question text — that appears in the structured fields.
- If nothing of substance happened, say so plainly in one sentence.

Context:
""
${transcript}
""`;

        const raw = await this.backend.complete(this.systemPrompt, userPrompt);
        const parsed = safeJson<CatchupSummary>(raw);
        const summary = parsed && typeof parsed.summary === "string" ? parsed.summary.trim() : "";
        if (!summary) {
            return { summary: "Could not synthesize a summary across the available context." };
        }
        return { summary };
    }

    async answerQuestion(
        question: string,
        context: {
            messages: Array<ContextMessage & { discordMessageId: string }>;
            decisions: string[];
            tasks: Array<{ title: string; assignee: string | null; dueDate: string | null }>;
            summaries: string[];
        },
    ): Promise<AnswerResult> {
        const transcriptLines: string[] = [];

        if (context.summaries.length > 0) {
            transcriptLines.push("PRIOR SUMMARIES:");
            for (const s of context.summaries) transcriptLines.push(`- ${s}`);
            transcriptLines.push("");
        }
        if (context.decisions.length > 0) {
            transcriptLines.push("KNOWN DECISIONS:");
            for (const d of context.decisions) transcriptLines.push(`- ${d}`);
            transcriptLines.push("");
        }
        if (context.tasks.length > 0) {
            transcriptLines.push("KNOWN TASKS:");
            for (const t of context.tasks) {
                const meta = [t.assignee ? `assignee: ${t.assignee}` : null, t.dueDate ? `due: ${t.dueDate}` : null]
                    .filter(Boolean)
                    .join(", ");
                transcriptLines.push(`- ${t.title}${meta ? ` (${meta})` : ""}`);
            }
            transcriptLines.push("");
        }

        transcriptLines.push("MESSAGES (most recent first):");
        for (const m of context.messages) {
            transcriptLines.push(
                `[${m.discordMessageId}] ${m.authorUsername} @ ${m.createdAt.toISOString()}: ${m.content}`,
            );
        }

        const transcript = truncate(transcriptLines.join("\n"), MAX_CONTEXT_CHARS);

        const userPrompt = `Answer the question using ONLY the provided context. If the context does not contain the answer, say so plainly.

Return JSON exactly matching this shape:
${ANSWER_SCHEMA_HINT}

When citing a message, set discordMessageId to the [id] shown in brackets in the transcript and snippet to a short excerpt. If you cannot ground a claim, omit citations.

Question: ${question.trim()}

Context:
""
${transcript}
""`;

        const raw = await this.backend.complete(this.systemPrompt, userPrompt);
        const parsed = safeJson<AnswerResult>(raw);
        if (!parsed) {
            return { answer: "I couldn't form a confident answer from the available context.", citations: [] };
        }

        return {
            answer: typeof parsed.answer === "string" ? parsed.answer.trim() : "",
            citations: Array.isArray(parsed.citations)
                ? parsed.citations
                      .filter((c) => c && typeof c.snippet === "string")
                      .map((c) => ({
                          discordMessageId:
                              typeof c.discordMessageId === "string" && c.discordMessageId.length > 0
                                  ? c.discordMessageId
                                  : undefined,
                          snippet: c.snippet.trim(),
                      }))
                : [],
        };
    }

    /** Round-trip a tiny JSON request through the backend; throws if the credential is bad. */
    async ping(): Promise<void> {
        const raw = await this.backend.complete(
            "Reply with JSON only.",
            'Return {"ok": true} as JSON.',
        );
        if (!raw) throw new Error("empty response from provider");
    }
}

// ──────── helpers ────────

function safeJson<T>(raw: string): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]) as T;
        } catch {
            return null;
        }
    }
}

function coerceImportance(value: unknown): Importance {
    if (value === "high" || value === "medium" || value === "low") return value;
    return "low";
}

function cleanStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((v): v is string => typeof v === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function cleanTaskArray(value: unknown): ExtractedTask[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((v) => {
            if (!v || typeof v !== "object") return null;
            const t = v as Partial<ExtractedTask>;
            if (typeof t.title !== "string" || t.title.trim().length === 0) return null;
            return {
                title: t.title.trim(),
                assignee: typeof t.assignee === "string" && t.assignee.trim().length > 0 ? t.assignee.trim() : null,
                dueDate: typeof t.dueDate === "string" && t.dueDate.trim().length > 0 ? t.dueDate.trim() : null,
            };
        })
        .filter((t): t is ExtractedTask => t !== null);
}

function renderTranscript(messages: ContextMessage[]): string {
    const lines = messages.map((m) => `${m.authorUsername} @ ${m.createdAt.toISOString()}: ${m.content}`);
    return truncate(lines.join("\n"), MAX_CONTEXT_CHARS);
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...[truncated]`;
}

/**
 * Compose the system prompt from the static base + the guild's optional language override.
 * The override is appended as a final, emphatic instruction so the model gives it priority
 * over the "match input language- default rule.
 */
function buildSystemPrompt(outputLanguage: string | null): string {
    if (!outputLanguage || outputLanguage.trim().length === 0) return SYSTEM_PROMPT_BASE;
    const lang = outputLanguage.trim();
    return `${SYSTEM_PROMPT_BASE}

LANGUAGE OVERRIDE (per-guild config): Write ALL natural-language strings — summary, decisions, tasks, openQuestions, answers, snippets — in **${lang}**, regardless of the input language. JSON keys, ISdates and Discord usernames stay as-is.`;
}

function renderExistingExtractions(existing: ExistingExtractions): string {
    const parts: string[] = [];
    if (existing.decisions.length > 0) {
        parts.push("Decisions already captured:");
        for (const d of existing.decisions) parts.push(`- ${d}`);
    } else {
        parts.push("Decisions already captured: (none)");
    }
    if (existing.tasks.length > 0) {
        parts.push("Tasks already captured:");
        for (const t of existing.tasks) {
            parts.push(`- ${t.title}${t.assignee ? ` (assignee: ${t.assignee})` : ""}`);
        }
    } else {
        parts.push("Tasks already captured: (none)");
    }
    if (existing.openQuestions.length > 0) {
        parts.push("Open questions already captured:");
        for (const q of existing.openQuestions) parts.push(`- ${q}`);
    } else {
        parts.push("Open questions already captured: (none)");
    }
    return parts.join("\n");
}

function humanReadableHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

// ──────── factory + cache ────────

interface CachedEntry {
    cacheKey: string;
    service: AiService;
}

const cacheByGuild = new Map<string, CachedEntry>();

function makeFallbackService(): AiService {
    const main = new OllamaBackend(env.OLLAMA_MODEL);
    const fast = env.OLLAMA_FAST_MODEL && env.OLLAMA_FAST_MODEL.length > 0
        ? new OllamaBackend(env.OLLAMA_FAST_MODEL)
        : main;
    return new AiService(main, { fastBackend: fast });
}

let fallbackService: AiService | null = null;
function getFallbackService(): AiService {
    if (!fallbackService) fallbackService = makeFallbackService();
    return fallbackService;
}

function buildCacheKey(cfg: GuildConfig): string {
    const keyHash = cfg.encryptedKey ? cfg.encryptedKey.slice(0, 16) : "none";
    return `${cfg.baseUrl ?? ""}|${cfg.model ?? ""}|${cfg.outputLanguage ?? ""}|${keyHash}`;
}

/**
 * Returns the AiService configured for this guild.
 *
 * - If the guild has a stored API key → OpenAI(-compatible) backend with that key + baseUrl.
 * - If the stored ciphertext fails to decrypt (e.g. CRYPTO_KEY rotated) → fall back to dev
 *   Ollama if `DEV_LOCAL_FALLBACK=true`, otherwise throw NoLlmConfigError.
 * - If the guild has no config at all → same dev fallback / throw rule.
 *
 * Throwing instead of silently falling back in production is intentional: a public bot
 * shouldn't pretend things work when an admin forgot to set up `/config api-key`.
 */
export async function aiServiceForGuild(guildId: string): Promise<AiService> {
    const cfg = await prisma.guildConfig.findUnique({ where: { guildId } });

    if (cfg?.encryptedKey) {
        const cacheKey = buildCacheKey(cfg);
        const cached = cacheByGuild.get(guildId);
        if (cached && cached.cacheKey === cacheKey) return cached.service;

        try {
            const apiKey = decrypt(cfg.encryptedKey);
            const model = cfg.model && cfg.model.length > 0 ? cfg.model : env.OPENAI_DEFAULT_MODEL;
            const backend = new OpenAiBackend(apiKey, model, cfg.baseUrl ?? undefined);
            const service = new AiService(backend, { outputLanguage: cfg.outputLanguage });
            cacheByGuild.set(guildId, { cacheKey, service });
            return service;
        } catch (err) {
            console.warn(`[ai] guild=${guildId} key decrypt failed`, err);
            // fall through to the no-config branch
        }
    }

    if (env.DEV_LOCAL_FALLBACK) {
        console.warn(`[ai] guild=${guildId} no key configured — using DEV_LOCAL_FALLBACK Ollama`);
        return getFallbackService();
    }

    throw new NoLlmConfigError(guildId);
}

/** Drop the cached AiService for a guild — call this from /config commands after writing. */
export function invalidateAiServiceCache(guildId: string): void {
    cacheByGuild.delete(guildId);
}

/**
 * Build a one-off AiService for testing a key the admin just typed in, BEFORE we persist it.
 * Used by the api-key modal flow.
 */
export function buildOpenAiTestService(apiKey: string, model: string, baseUrl?: string): AiService {
    return new AiService(new OpenAiBackend(apiKey, model, baseUrl));
}

export type { AiService };
