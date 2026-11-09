import { Importance, SummaryKind, type Summary } from "@prisma/client";
import { prisma } from "../db/prisma";
import {
    aiServiceForGuild,
    type ChunkMessage,
    type ChunkSummary,
    type ExistingExtractions,
} from "./ai.service";

export const CHUNK_TARGET_MESSAGES = 100;
export const CHUNK_MAX_HOURS = 6;
const SYNC_BUILD_BUDGET = 3;

const importanceToTag: Record<Importance, ChunkMessage["importance"]> = {
    LOW: "low",
    MEDIUM: "medium",
    HIGH: "high",
};

interface BuildableRange {
    fromExclusive: Date | null;
    fromMessageIdExclusive: string | null;
}

interface BuildResult {
    chunks: ChunkSummary[];
    cachedCount: number;
    freshCount: number;
    deferredCount: number;
}

/**
 * Concurrent /catchup callers should coalesce on a single in-flight build per (channel, range start).
 * Map keys are deterministic so two callers asking for the same chunk wait on the same Promise.
 */
const inFlight = new Map<string, Promise<Summary | null>>();

function lockKey(channelId: string, fromMs: number): string {
    return `${channelId}@${fromMs}`;
}

/**
 * Decide whether the next chunk after `fromExclusive` can be built right now.
 *
 * A chunk closes once we have enough messages (CHUNK_TARGET_MESSAGES) OR enough wall-clock has
 * elapsed (CHUNK_MAX_HOURS) since `fromExclusive`. If the channel has fresh activity but neither
 * threshold is crossed, the trailing portion is left to `tail` instead of being baked into a chunk.
 */
async function canCloseChunkAfter(channelId: string, fromExclusive: Date | null): Promise<boolean> {
    const cutoffStart = fromExclusive ?? new Date(0);
    const candidates = await prisma.message.findMany({
        where: { channelId, createdAt: { gt: cutoffStart } },
        orderBy: { createdAt: "asc" },
        take: CHUNK_TARGET_MESSAGES,
        select: { createdAt: true },
    });
    if (candidates.length === 0) return false;
    if (candidates.length >= CHUNK_TARGET_MESSAGES) return true;
    const oldestNew = candidates[0].createdAt;
    const span = Date.now() - oldestNew.getTime();
    return span >= CHUNK_MAX_HOURS * 60 * 60 * 1000;
}

async function findLatestChunk(channelId: string): Promise<Summary | null> {
    return prisma.summary.findFirst({
        where: { channelId, kind: SummaryKind.CHUNK },
        orderBy: { windowEnd: "desc" },
    });
}

/**
 * Build the chunk that starts immediately after `fromExclusive`. The window covers the next
 * CHUNK_TARGET_MESSAGES messages or up to CHUNK_MAX_HOURS, whichever comes first. Returns null
 * if there's nothing to build (no messages after the cursor).
 *
 * Idempotent: a unique constraint on (channelId, kind, windowStart, windowEnd) means two
 * concurrent calls collapse into a single row.
 */
export async function buildNextChunk(
    channelId: string,
    guildId: string,
    fromExclusive: Date | null,
): Promise<Summary | null> {
    const key = lockKey(channelId, fromExclusive?.getTime() ?? 0);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
        const cutoffStart = fromExclusive ?? new Date(0);
        const messages = await prisma.message.findMany({
            where: { channelId, createdAt: { gt: cutoffStart } },
            orderBy: { createdAt: "asc" },
            take: CHUNK_TARGET_MESSAGES,
            select: {
                discordMessageId: true,
                authorUsername: true,
                content: true,
                createdAt: true,
                importance: true,
            },
        });
        if (messages.length === 0) return null;

        const oldest = messages[0].createdAt;
        const wallClockBoundary = new Date(oldest.getTime() + CHUNK_MAX_HOURS * 60 * 60 * 1000);
        // Trim to the wall-clock boundary if we'd otherwise span beyond CHUNK_MAX_HOURS.
        const trimmed = messages.filter((m) => m.createdAt <= wallClockBoundary);
        const final = trimmed.length > 0 ? trimmed : messages.slice(0, 1);

        const windowStart = fromExclusive ?? new Date(oldest.getTime() - 1);
        const windowEnd = final[final.length - 1].createdAt;
        const lastMessageId = final[final.length - 1].discordMessageId;

        const chunkMessages: ChunkMessage[] = final.map((m) => ({
            authorUsername: m.authorUsername,
            content: m.content,
            createdAt: m.createdAt,
            importance: m.importance ? importanceToTag[m.importance] : null,
        }));

        // Feed per-message extractions for this exact window into the prompt so the AI
        // doesn't re-emit them. This is our dedup strategy — way cheaper than a separate AI pass.
        const existing = await fetchExistingExtractions(channelId, windowStart, windowEnd);

        const t0 = Date.now();
        const ai = await aiServiceForGuild(guildId);
        const result = await ai.summarizeChunk(chunkMessages, existing);
        const ms = Date.now() - t0;
        console.log(
            `[digest] built chunk channel=${channelId} msgs=${final.length} ` +
                `span=${windowStart.toISOString()}→${windowEnd.toISOString()} ` +
                `provider=${ai.info.label}/${ai.info.model} ` +
                `new(d/t/q)=${result.newDecisions.length}/${result.newTasks.length}/${result.newOpenQuestions.length} ` +
                `(${ms}ms)`,
        );

        let row: Summary | null;
        try {
            row = await prisma.summary.create({
                data: {
                    guildId,
                    channelId,
                    kind: SummaryKind.CHUNK,
                    windowStart,
                    windowEnd,
                    text: result.summary,
                    messageCount: final.length,
                    lastMessageId,
                },
            });
        } catch (err: unknown) {
            // Race: another worker landed the same chunk first. Read whoever's there now.
            console.warn(`[digest] insert race for channel=${channelId}, fetching winner.`, err);
            row = await prisma.summary.findFirst({
                where: { channelId, kind: SummaryKind.CHUNK, windowStart, windowEnd },
            });
            // Don't double-persist new items if another worker already handled this chunk.
            return row;
        }

        // Persist multi-message decisions/tasks/questions linked to no specific message
        // (sourceMessageId stays null since the signal came from the conversation, not one line).
        const ops: Promise<unknown>[] = [];
        for (const text of result.newDecisions) {
            ops.push(prisma.decision.create({ data: { guildId, channelId, text } }));
        }
        for (const t of result.newTasks) {
            ops.push(
                prisma.task.create({
                    data: {
                        guildId,
                        channelId,
                        title: t.title,
                        assignee: t.assignee,
                        dueDate: parseDate(t.dueDate),
                    },
                }),
            );
        }
        for (const text of result.newOpenQuestions) {
            ops.push(prisma.openQuestion.create({ data: { guildId, channelId, text } }));
        }
        if (ops.length > 0) await Promise.all(ops);

        return row;
    })();

    inFlight.set(key, promise);
    try {
        return await promise;
    } finally {
        inFlight.delete(key);
    }
}

async function fetchExistingExtractions(
    channelId: string,
    windowStart: Date,
    windowEnd: Date,
): Promise<ExistingExtractions> {
    const [decisions, tasks, openQuestions] = await Promise.all([
        prisma.decision.findMany({
            where: { channelId, createdAt: { gte: windowStart, lte: windowEnd } },
            select: { text: true },
        }),
        prisma.task.findMany({
            where: { channelId, createdAt: { gte: windowStart, lte: windowEnd } },
            select: { title: true, assignee: true },
        }),
        prisma.openQuestion.findMany({
            where: { channelId, createdAt: { gte: windowStart, lte: windowEnd } },
            select: { text: true },
        }),
    ]);
    return {
        decisions: decisions.map((d) => d.text),
        tasks: tasks.map((t) => ({ title: t.title, assignee: t.assignee })),
        openQuestions: openQuestions.map((q) => q.text),
    };
}

function parseDate(value: string | null): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function rowToChunk(row: Summary): ChunkSummary {
    return {
        summary: row.text,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        messageCount: row.messageCount,
    };
}

/**
 * Return the chunk summaries covering [since, until) for a channel. Lazily builds any missing
 * chunks up to SYNC_BUILD_BUDGET; anything beyond that is reported via `deferredCount` so the
 * caller can tell the user to re-run. Pre-built chunks (from the worker tail) are reused.
 */
export async function getOrBuildChunks(
    channelId: string,
    guildId: string,
    since: Date,
): Promise<BuildResult> {
    const cached = await prisma.summary.findMany({
        where: {
            channelId,
            kind: SummaryKind.CHUNK,
            windowEnd: { gt: since },
        },
        orderBy: { windowEnd: "asc" },
    });

    // Anchor the first chunk to `since` so /catchup never spawns work on history older than asked.
    // Subsequent chunks tile forward from each previous chunk's windowEnd.
    let cursor: Date = cached.length > 0 ? cached[cached.length - 1].windowEnd : new Date(since.getTime() - 1);
    let fresh = 0;
    let deferred = 0;
    const built: Summary[] = [];

    while (true) {
        const closeable = await canCloseChunkAfter(channelId, cursor);
        if (!closeable) break;

        if (fresh >= SYNC_BUILD_BUDGET) {
            // Count remaining buildable chunks but don't run them inline.
            deferred++;
            // Skip cursor forward by one chunk's worth so we can detect whether more buildable
            // chunks exist after this one without inspecting every message.
            const peek = await prisma.message.findFirst({
                where: { channelId, createdAt: { gt: cursor } },
                orderBy: { createdAt: "asc" },
                skip: CHUNK_TARGET_MESSAGES - 1,
                select: { createdAt: true },
            });
            if (!peek) break;
            cursor = peek.createdAt;
            continue;
        }

        const row = await buildNextChunk(channelId, guildId, cursor);
        if (!row) break;
        built.push(row);
        cursor = row.windowEnd;
        fresh++;
    }

    const all = [...cached, ...built].sort(
        (a, b) => a.windowStart.getTime() - b.windowStart.getTime(),
    );

    return {
        chunks: all.map(rowToChunk),
        cachedCount: cached.length,
        freshCount: fresh,
        deferredCount: deferred,
    };
}

/**
 * Used by the worker tail: build the next chunk for a channel if its trailing window has closed.
 * No-op for channels that have never been digested — the first anchor must come from /catchup so
 * we don't kick off chunk-building over arbitrarily old history.
 */
export async function tryPreBuildOne(channelId: string, guildId: string): Promise<boolean> {
    const last = await findLatestChunk(channelId);
    if (!last) return false;
    if (!(await canCloseChunkAfter(channelId, last.windowEnd))) return false;
    const row = await buildNextChunk(channelId, guildId, last.windowEnd);
    return row !== null;
}

export const digestService = {
    getOrBuildChunks,
    buildNextChunk,
    tryPreBuildOne,
    findLatestChunk,
};
