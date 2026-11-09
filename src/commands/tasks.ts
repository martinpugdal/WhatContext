import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { TaskStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import type { ContextCommand } from "../services/command.service";

const DEFAULT_LIMIT = 10;

const command: ContextCommand = {
    data: new SlashCommandBuilder()
        .setName("tasks")
        .setDescription("List recent tasks captured in this server.")
        .addBooleanOption((opt) =>
            opt.setName("channel_only").setDescription("Only show tasks from this channel."),
        )
        .addBooleanOption((opt) =>
            opt.setName("open_only").setDescription("Only show tasks that aren't done."),
        )
        .addIntegerOption((opt) =>
            opt
                .setName("limit")
                .setDescription(`How many to show (default ${DEFAULT_LIMIT}, max 25).`)
                .setMinValue(1)
                .setMaxValue(25),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
            return;
        }

        const channelOnly = interaction.options.getBoolean("channel_only") ?? false;
        const openOnly = interaction.options.getBoolean("open_only") ?? true;
        const limit = interaction.options.getInteger("limit") ?? DEFAULT_LIMIT;

        await interaction.deferReply();

        const tasks = await prisma.task.findMany({
            where: {
                guildId: interaction.guildId,
                ...(channelOnly ? { channelId: interaction.channelId } : {}),
                ...(openOnly ? { status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } } : {}),
            },
            orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
            take: limit,
            include: { source: { select: { discordMessageId: true, channelId: true } } },
        });

        if (tasks.length === 0) {
            await interaction.editReply(
                openOnly ? "No open tasks saved for this scope." : "No tasks saved yet.",
            );
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle("Tasks")
            .setColor(0xfee75c)
            .setTimestamp();

        const lines = tasks.map((t) => {
            const meta: string[] = [statusIcon(t.status)];
            if (t.assignee) meta.push(`👤 ${t.assignee}`);
            if (t.dueDate) meta.push(`📅 <t:${Math.floor(t.dueDate.getTime() / 1000)}:d>`);
            const link = t.source
                ? ` - [source](https://discord.com/channels/${interaction.guildId}/${t.source.channelId}/${t.source.discordMessageId})`
                : "";
            return `${meta.join(" ")} ${truncate(t.title, 160)}${link}`;
        });

        embed.setDescription(lines.join("\n").slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
    },
};

function statusIcon(status: TaskStatus): string {
    switch (status) {
        case TaskStatus.DONE:
            return "✅";
        case TaskStatus.IN_PROGRESS:
            return "🔄";
        case TaskStatus.CANCELLED:
            return "🚫";
        default:
            return "⬜";
    }
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

export default command;
