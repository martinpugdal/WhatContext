import type { Message as DiscordMessage } from "discord.js";
import { Importance as PrismaImportance } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import { aiServiceForGuild, NoLlmConfigError, type Importance, type MessageAnalysis } from "./ai.service";
import { digestService } from "./digest.service";

const MIN_STORE_LENGTH = 2;
const MIN_ANALYZE_LENGTH = 12;

const importanceMap: Record<Importance, PrismaImportance> = {
    low: PrismaImportance.LOW,
    medium: PrismaImportance.MEDIUM,
    high: PrismaImportance.HIGH,
};

interface PendingAnalysis {
    storedId: string;
    content: string;
    guildId: string;
    channelId: string;
    authorUsername: string;
}

let allowListCache: { ids: Set<string>; loadedAt: number } | null = null;
const ALLOW_LIST_TTL_MS = 30_000;

async function loadAllowList(): Promise<Set<string>> {
    const now = Date.now();
    if (allowListCache && now - allowListCache.loadedAt < ALLOW_LIST_TTL_MS) {
        return allowListCache.ids;
    }
    const rows = await prisma.watchedChannel.findMany({ select: { channelId: true } });
    const ids = new Set(rows.map((r) => r.channelId));
    allowListCache = { ids, loadedAt: now };
    return ids;
}

function invalidateAllowList(): void {
    allowListCache = null;
}

const pendingByChannel = new Map<string, PendingAnalysis[]>();
const debounceTimers = new Map<string, NodeJS.Timeout>();
const queue: PendingAnalysis[] = [];
let workerActive = false;

async function isChannelAllowed(channelId: string): Promise<boolean> {
    const allowed = await loadAllowList();
    return allowed.has(channelId);
}

function scheduleAnalysis(item: PendingAnalysis): void {
    const list = pendingByChannel.get(item.channelId) ?? [];
    list.push(item);
    pendingByChannel.set(item.channelId, list);

    const existing = debounceTimers.get(item.channelId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
        debounceTimers.delete(item.channelId);
        const flushed = pendingByChannel.get(item.channelId) ?? [];
        pendingByChannel.delete(item.channelId);
        if (flushed.length === 0) return;
        for (const p of flushed) queue.push(p);
        console.log(
            `[ingest] queue +${flushed.length} (channel=${item.channelId}, total=${queue.length})`,
        );
        void runWorker();
    }, env.ANALYZE_DEBOUNCE_MS);

    debounceTimers.set(item.channelId, timer);
}

async function runWorker(): Promise<void> {
    if (workerActive) return;
    workerActive = true;
    const touchedChannels = new Map<string, string>(); // channelId → guildId
    try {
        while (queue.length > 0) {
            const task = queue.shift();
            if (!task) break;
            touchedChannels.set(task.channelId, task.guildId);
            try {
                await analyzeAndPersist(task);
            } catch (err) {
                console.error(`[ingest] worker task failed (msg=${task.storedId}):`, err);
            }
        }
    } finally {
        workerActive = false;
    }

    // Opportunistic chunk pre-build. Runs after ingest drains so it never blocks fresh analysis.
    // Each touched channel gets at most one chunk built per worker pass; if more are owed,
    // the next ingest burst will pick up where we left off.
    for (const [channelId, guildId] of touchedChannels) {
        try {
            const built = await digestService.tryPreBuildOne(channelId, guildId);
            if (built && queue.length > 0) {
                // New ingest tasks arrived during the build — drain them before another pre-build.
                void runWorker();
                return;
            }
        } catch (err) {
            if (err instanceof NoLlmConfigError) continue;
            console.error(`[ingest] chunk pre-build failed for channel=${channelId}:`, err);
        }
    }
}

async function analyzeAndPersist(task: PendingAnalysis): Promise<void> {
    const startedAt = Date.now();
    let analysis: MessageAnalysis | null = null;
    try {
        const ai = await aiServiceForGuild(task.guildId);
        analysis = await ai.analyzeMessage(task.content);
    } catch (err) {
        if (err instanceof NoLlmConfigError) {
            // Don't spam logs — one warning per worker run is enough.
            return;
        }
        console.error("[ingest] analyzeMessage failed:", err);
        return;
    }
    if (!analysis) return;

    const ms = Date.now() - startedAt;
    console.log(
        `[ingest] ${task.authorUsername} → importance=${analysis.importance} ` +
            `decisions=${analysis.decisions.length} tasks=${analysis.tasks.length} ` +
            `questions=${analysis.openQuestions.length} (${ms}ms)`,
    );

    await prisma.message.update({
        where: { id: task.storedId },
        data: {
            importance: importanceMap[analysis.importance],
            analyzedAt: new Date(),
        },
    });

    if (analysis.importance === "low") return;

    const ctx = {
        guildId: task.guildId,
        channelId: task.channelId,
        sourceMessageId: task.storedId,
    };

    const ops: Promise<unknown>[] = [];
    for (const text of analysis.decisions) {
        ops.push(prisma.decision.create({ data: { ...ctx, text } }));
    }
    for (const t of analysis.tasks) {
        ops.push(
            prisma.task.create({
                data: {
                    ...ctx,
                    title: t.title,
                    assignee: t.assignee,
                    dueDate: parseDate(t.dueDate),
                },
            }),
        );
    }
    for (const text of analysis.openQuestions) {
        ops.push(prisma.openQuestion.create({ data: { ...ctx, text } }));
    }
    if (ops.length > 0) await Promise.all(ops);
}

function parseDate(value: string | null): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export const messageService = {
    /**
     * Reflect a Discord message edit in our DB. We deliberately don't re-trigger AI analysis
     * — edits are usually typo-fixes and re-analyzing would invalidate Decision/Task rows
     * that already linked to the message. Updating the content keeps `/decisions` source links
     * pointing at the latest version, which is what users expect.
     */
    async handleEdit(messageId: string, newContent: string): Promise<void> {
        const trimmed = newContent.trim();
        if (trimmed.length < MIN_STORE_LENGTH) return;
        try {
            await prisma.message.update({
                where: { discordMessageId: messageId },
                data: { content: trimmed },
            });
        } catch (err) {
            // P2025 = record not found; harmless if we never ingested the original (e.g. bot wasn't
            // a member at the time) so don't spam the log.
            if ((err as { code?: string })?.code !== "P2025") {
                console.error(`[messageService] handleEdit failed for ${messageId}:`, err);
            }
        }
    },

    /**
     * Reflect a Discord message deletion. The Message row is removed; Decision/Task/OpenQuestion
     * rows that referenced it survive with `sourceMessageId = null` thanks to the schema's
     * `onDelete: SetNull` rule — losing the source link is acceptable, but losing a captured
     * decision because someone deleted their message would be much worse.
     */
    async handleDelete(messageId: string): Promise<void> {
        try {
            await prisma.message.delete({ where: { discordMessageId: messageId } });
        } catch (err) {
            if ((err as { code?: string })?.code !== "P2025") {
                console.error(`[messageService] handleDelete failed for ${messageId}:`, err);
            }
        }
    },

    /**
     * Persist a Discord message. Analysis runs on a per-channel debounced queue with a single
     * serial worker — bursts of messages in the same channel are coalesced and processed only
     * after the channel goes quiet (see ANALYZE_DEBOUNCE_MS). Channels outside ANALYZE_CHANNEL_IDS
     * are stored but never analyzed.
     */
    async ingest(message: DiscordMessage): Promise<void> {
        if (message.author.bot) return;
        if (!message.guildId) return;
        const content = message.content?.trim();
        if (!content || content.length < MIN_STORE_LENGTH) return;

        const stored = await prisma.message.upsert({
            where: { discordMessageId: message.id },
            create: {
                discordMessageId: message.id,
                guildId: message.guildId,
                channelId: message.channelId,
                authorId: message.author.id,
                authorUsername: message.author.username,
                content,
                createdAt: message.createdAt,
            },
            update: {
                content,
                authorUsername: message.author.username,
            },
        });

        if (content.length < MIN_ANALYZE_LENGTH) return;
        if (!(await isChannelAllowed(message.channelId))) return;

        scheduleAnalysis({
            storedId: stored.id,
            content,
            guildId: message.guildId,
            channelId: message.channelId,
            authorUsername: message.author.username,
        });
    },

    /**
     * Test-friendly accessor for the in-memory queue depth.
     */
    queueDepth(): number {
        return queue.length + [...pendingByChannel.values()].reduce((s, l) => s + l.length, 0);
    },

    /** Drop the cached watched-channel list so the next ingest reads fresh from DB. */
    invalidateAllowList,
};
