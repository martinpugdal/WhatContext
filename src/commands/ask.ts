import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { prisma } from "../db/prisma";
import { descriptionLocalizations, t } from "../i18n";
import { aiServiceForGuild, NoLlmConfigError } from "../services/ai.service";
import type { ContextCommand } from "../services/command.service";

const MAX_MESSAGES = 80;
const MAX_DECISIONS = 20;
const MAX_TASKS = 20;
const MAX_SUMMARIES = 8;

const command: ContextCommand = {
    data: new SlashCommandBuilder()
        .setName("ask")
        .setDescription(t("ask.cmd.description", null))
        .setDescriptionLocalizations(descriptionLocalizations("ask.cmd.description"))
        .addStringOption((opt) =>
            opt
                .setName("question")
                .setDescription(t("ask.opt.question", null))
                .setDescriptionLocalizations(descriptionLocalizations("ask.opt.question"))
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(500),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
            return;
        }

        const question = interaction.options.getString("question", true);

        await interaction.deferReply();

        const t0 = Date.now();
        const scope = { guildId: interaction.guildId, channelId: interaction.channelId };

        const [messages, decisions, tasks, summaries] = await Promise.all([
            prisma.message.findMany({
                where: scope,
                orderBy: { createdAt: "desc" },
                take: MAX_MESSAGES,
                select: { discordMessageId: true, authorUsername: true, content: true, createdAt: true },
            }),
            prisma.decision.findMany({
                where: scope,
                orderBy: { createdAt: "desc" },
                take: MAX_DECISIONS,
                select: { text: true },
            }),
            prisma.task.findMany({
                where: scope,
                orderBy: { createdAt: "desc" },
                take: MAX_TASKS,
                select: { title: true, assignee: true, dueDate: true },
            }),
            prisma.summary.findMany({
                where: { ...scope, kind: { in: ["CATCHUP", "CHUNK"] } },
                // CATCHUP < CHUNK alphabetically, so CATCHUPs come first; chunks ordered most recent first.
                orderBy: [{ kind: "asc" }, { windowEnd: "desc" }],
                take: MAX_SUMMARIES,
                select: { text: true },
            }),
        ]);

        if (messages.length === 0 && decisions.length === 0 && tasks.length === 0 && summaries.length === 0) {
            await interaction.editReply("I don't have any stored context for this channel yet.");
            return;
        }
        const tDb = Date.now() - t0;

        const tAi0 = Date.now();
        let result;
        try {
            const ai = await aiServiceForGuild(interaction.guildId);
            result = await ai.answerQuestion(question, {
                messages,
                decisions: decisions.map((d) => d.text),
                tasks: tasks.map((t) => ({
                    title: t.title,
                    assignee: t.assignee,
                    dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
                })),
                summaries: summaries.map((s) => s.text),
            });
        } catch (err) {
            if (err instanceof NoLlmConfigError) {
                await interaction.editReply(
                    "🔑 This server has no LLM configured yet. An admin needs to run `/config api-key` first.",
                );
                return;
            }
            throw err;
        }

        const tAi = Date.now() - tAi0;
        console.log(
            `[ask] msgs=${messages.length} decisions=${decisions.length} tasks=${tasks.length} ` +
                `summaries=${summaries.length} db=${tDb}ms ai=${tAi}ms`,
        );

        const embed = new EmbedBuilder()
            .setTitle("Answer")
            .setColor(0xeb459e)
            .setDescription(result.answer || "_No answer generated._")
            .addFields({ name: "Question", value: truncate(question, 1024) })
            .setFooter({ text: `db ${tDb}ms · ai ${(tAi / 1000).toFixed(1)}s` })
            .setTimestamp();

        if (result.citations.length > 0) {
            const lines = result.citations.slice(0, 5).map((c) => {
                const link = c.discordMessageId
                    ? `[source](https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${c.discordMessageId})`
                    : "source";
                return `• ${link} — ${truncate(c.snippet, 180)}`;
            });
            embed.addFields({ name: "Sources", value: lines.join("\n").slice(0, 1024) });
        }

        await interaction.editReply({ embeds: [embed] });
    },
};

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

export default command;
