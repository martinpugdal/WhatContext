import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { TaskStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import { descriptionLocalizations, t } from "../i18n";
import { aiServiceForGuild, NoLlmConfigError } from "../services/ai.service";
import { digestService } from "../services/digest.service";
import type { ContextCommand } from "../services/command.service";

const DEFAULT_HOURS = 12;
const TAIL_LIMIT = 200;
const ITEM_LIMIT = 25;

const command: ContextCommand = {
    data: new SlashCommandBuilder()
        .setName("catchup")
        .setDescription(t("catchup.cmd.description", null))
        .setDescriptionLocalizations(descriptionLocalizations("catchup.cmd.description"))
        .addNumberOption((opt) =>
            opt
                .setName("hours")
                .setDescription(t("catchup.opt.hours", null, { default: DEFAULT_HOURS }))
                .setDescriptionLocalizations(descriptionLocalizations("catchup.opt.hours", { default: DEFAULT_HOURS }))
                .setMinValue(1)
                .setMaxValue(168),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        const locale = interaction.locale;
        if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({ content: t("error.guildOnly", locale), flags: MessageFlags.Ephemeral });
            return;
        }

        const hours = interaction.options.getNumber("hours") ?? DEFAULT_HOURS;
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);

        await interaction.deferReply();

        const t0 = Date.now();
        const totalCount = await prisma.message.count({
            where: { channelId: interaction.channelId, createdAt: { gte: since } },
        });

        if (totalCount === 0) {
            await interaction.editReply(t("catchup.empty", locale, { hours }));
            return;
        }

        const tDigest0 = Date.now();
        let chunks, cachedCount, freshCount, deferredCount;
        try {
            ({ chunks, cachedCount, freshCount, deferredCount } = await digestService.getOrBuildChunks(
                interaction.channelId,
                interaction.guildId,
                since,
            ));
        } catch (err) {
            if (err instanceof NoLlmConfigError) {
                await interaction.editReply(
                    t("error.noLlmConfig", locale),
                );
                return;
            }
            throw err;
        }
        const tDigest = Date.now() - tDigest0;

        const tailFromDate = chunks.length > 0 ? chunks[chunks.length - 1].windowEnd : since;
        const tail = await prisma.message.findMany({
            where: {
                channelId: interaction.channelId,
                createdAt: { gt: tailFromDate },
            },
            orderBy: { createdAt: "asc" },
            take: TAIL_LIMIT,
            select: { authorUsername: true, content: true, createdAt: true },
        });

        if (chunks.length === 0 && tail.length === 0) {
            await interaction.editReply(
                `Saw **${totalCount}** message(s) in the last ${hours}h but couldn't build a digest yet — try again in a few seconds.`,
            );
            return;
        }

        const tReduce0 = Date.now();
        let ai, result;
        try {
            ai = await aiServiceForGuild(interaction.guildId);
            result = await ai.reduceChunks(chunks, tail);
        } catch (err) {
            if (err instanceof NoLlmConfigError) {
                await interaction.editReply(
                    t("error.noLlmConfig", locale),
                );
                return;
            }
            throw err;
        }
        const tReduce = Date.now() - tReduce0;

        // Pull the canonical structured items from DB for the same window. These are the same
        // rows /decisions and /tasks would show — guaranteed consistent.
        const sourceFields = { discordMessageId: true, channelId: true } as const;
        const [decisions, tasksRows, openQuestions] = await Promise.all([
            prisma.decision.findMany({
                where: {
                    channelId: interaction.channelId,
                    createdAt: { gte: since },
                    supersededAt: null,
                },
                orderBy: { createdAt: "asc" },
                take: ITEM_LIMIT,
                include: { source: { select: sourceFields } },
            }),
            prisma.task.findMany({
                where: {
                    channelId: interaction.channelId,
                    createdAt: { gte: since },
                    status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
                },
                orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
                take: ITEM_LIMIT,
                include: { source: { select: sourceFields } },
            }),
            prisma.openQuestion.findMany({
                where: {
                    channelId: interaction.channelId,
                    createdAt: { gte: since },
                    resolved: false,
                },
                orderBy: { createdAt: "asc" },
                take: ITEM_LIMIT,
                include: { source: { select: sourceFields } },
            }),
        ]);

        const tTotal = Date.now() - t0;

        await prisma.summary.create({
            data: {
                guildId: interaction.guildId,
                channelId: interaction.channelId,
                kind: "CATCHUP",
                windowStart: since,
                windowEnd: new Date(),
                text: result.summary,
                messageCount: totalCount,
            },
        });

        console.log(
            `[catchup] hours=${hours} chunks=${chunks.length} cached=${cachedCount} fresh=${freshCount} ` +
                `deferred=${deferredCount} tail=${tail.length} total_msgs=${totalCount} ` +
                `decisions=${decisions.length} tasks=${tasksRows.length} questions=${openQuestions.length} ` +
                `provider=${ai.info.label}/${ai.info.model} ` +
                `digest=${tDigest}ms reduce=${tReduce}ms total=${tTotal}ms`,
        );

        const footerParts = [
            `${chunks.length} chunks`,
            `${tail.length} tail`,
            `${cachedCount} cached`,
            `${freshCount} fresh`,
            `${decisions.length}d · ${tasksRows.length}t · ${openQuestions.length}q`,
            `reduce ${(tReduce / 1000).toFixed(1)}s`,
        ];
        if (deferredCount > 0) footerParts.push(`${deferredCount} pending`);

        const embed = new EmbedBuilder()
            .setTitle(t("catchup.title", locale, { hours }))
            .setColor(0x5865f2)
            .setDescription(result.summary || t("catchup.summary.empty", locale))
            .setFooter({ text: footerParts.join(" ") })
            .setTimestamp();

        if (deferredCount > 0) {
            embed.addFields({
                name: t("catchup.indexing", locale),
                value: t("catchup.indexingBody", locale, { count: deferredCount }),
            });
        }

        if (decisions.length > 0) {
            embed.addFields({
                name: t("catchup.field.decisions", locale, { count: decisions.length }),
                value: decisions
                    .map((d) => `• ${truncate(d.text, 180)}${formatSource(d.source, interaction.guildId)}`)
                    .join("\n")
                    .slice(0, 1024),
            });
        }
        if (tasksRows.length > 0) {
            embed.addFields({
                name: t("catchup.field.tasks", locale, { count: tasksRows.length }),
                value: tasksRows
                    .map((tk) => {
                        const meta = formatTaskMeta(
                            tk.assignee,
                            tk.dueDate ? tk.dueDate.toISOString().slice(0, 10) : null,
                        );
                        return `• ${truncate(tk.title, 140)}${meta}${formatSource(tk.source, interaction.guildId)}`;
                    })
                    .join("\n")
                    .slice(0, 1024),
            });
        }
        if (openQuestions.length > 0) {
            embed.addFields({
                name: t("catchup.field.openQuestions", locale, { count: openQuestions.length }),
                value: openQuestions
                    .map((q) => `• ${truncate(q.text, 180)}${formatSource(q.source, interaction.guildId)}`)
                    .join("\n")
                    .slice(0, 1024),
            });
        }

        await interaction.editReply({ embeds: [embed] });
    },
};

function formatTaskMeta(assignee: string | null, dueDate: string | null): string {
    const parts: string[] = [];
    if (assignee) parts.push(`👤 ${assignee}`);
    if (dueDate) parts.push(`📅 ${dueDate}`);
    return parts.length > 0 ? `  _(${parts.join(", ")})_` : "";
}

function formatSource(
    source: { discordMessageId: string; channelId: string } | null,
    guildId: string,
): string {
    if (!source) return "";
    return ` — [source](https://discord.com/channels/${guildId}/${source.channelId}/${source.discordMessageId})`;
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

export default command;
