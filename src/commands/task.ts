import {
    type AutocompleteInteraction,
    type ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { TaskStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import type { ContextCommand } from "../services/command.service";

const DEFAULT_LIMIT = 10;
const AUTOCOMPLETE_LIMIT = 25;

const command: ContextCommand = {
    data: new SlashCommandBuilder()
        .setName("task")
        .setDescription("Manage tasks captured by ContextBot.")
        .addSubcommand((sub) =>
            sub
                .setName("done")
                .setDescription("Mark a task as done.")
                .addStringOption((opt) =>
                    opt.setName("id").setDescription("The task to update.").setRequired(true).setAutocomplete(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName("cancel")
                .setDescription("Cancel a task.")
                .addStringOption((opt) =>
                    opt.setName("id").setDescription("The task to cancel.").setRequired(true).setAutocomplete(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName("assign")
                .setDescription("Assign or reassign a task to a Discord user.")
                .addStringOption((opt) =>
                    opt.setName("id").setDescription("The task to assign.").setRequired(true).setAutocomplete(true),
                )
                .addUserOption((opt) =>
                    opt.setName("user").setDescription("Who to assign it to.").setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName("list")
                .setDescription("List tasks in this server.")
                .addBooleanOption((opt) =>
                    opt.setName("channel_only").setDescription("Only this channel."),
                )
                .addBooleanOption((opt) =>
                    opt.setName("open_only").setDescription("Hide done/cancelled (default true)."),
                )
                .addIntegerOption((opt) =>
                    opt
                        .setName("limit")
                        .setDescription(`Max items (default ${DEFAULT_LIMIT}, max 25).`)
                        .setMinValue(1)
                        .setMaxValue(25),
                ),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
            return;
        }

        const sub = interaction.options.getSubcommand();
        switch (sub) {
            case "done":
                await setStatus(interaction, TaskStatus.DONE);
                return;
            case "cancel":
                await setStatus(interaction, TaskStatus.CANCELLED);
                return;
            case "assign":
                await assignTask(interaction);
                return;
            case "list":
                await listTasks(interaction);
                return;
            default:
                await interaction.reply({ content: `Unknown subcommand: ${sub}`, flags: MessageFlags.Ephemeral });
        }
    },

    async autocomplete(interaction: AutocompleteInteraction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== "id" || !interaction.guildId) {
            await interaction.respond([]);
            return;
        }

        const sub = interaction.options.getSubcommand();
        const onlyOpen = sub !== "list";
        const query = focused.value.trim();

        const tasks = await prisma.task.findMany({
            where: {
                guildId: interaction.guildId,
                ...(onlyOpen ? { status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } } : {}),
                ...(query.length > 0 ? { title: { contains: query, mode: "insensitive" } } : {}),
            },
            orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
            take: AUTOCOMPLETE_LIMIT,
            select: { id: true, title: true, status: true, assignee: true, dueDate: true },
        });

        await interaction.respond(
            tasks.map((t) => ({
                name: truncate(formatChoiceLabel(t), 100),
                value: t.id,
            })),
        );
    },
};

async function setStatus(interaction: ChatInputCommandInteraction, status: TaskStatus): Promise<void> {
    const id = interaction.options.getString("id", true);

    const task = await prisma.task.findUnique({ where: { id } });
    if (!task || task.guildId !== interaction.guildId) {
        await interaction.reply({ content: "Task not found in this server.", flags: MessageFlags.Ephemeral });
        return;
    }

    if (task.status === status) {
        await interaction.reply({
            content: `Task **${task.title}** is already ${status.toLowerCase()}.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const updated = await prisma.task.update({ where: { id }, data: { status } });
    const verb = status === TaskStatus.DONE ? "✅ Marked as done" : "🚫 Cancelled";
    await interaction.reply({ content: `${verb}: **${truncate(updated.title, 200)}**` });
}

async function assignTask(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString("id", true);
    const user = interaction.options.getUser("user", true);

    const task = await prisma.task.findUnique({ where: { id } });
    if (!task || task.guildId !== interaction.guildId) {
        await interaction.reply({ content: "Task not found in this server.", flags: MessageFlags.Ephemeral });
        return;
    }

    const updated = await prisma.task.update({ where: { id }, data: { assignee: user.username } });
    await interaction.reply({
        content: `👤 Assigned **${truncate(updated.title, 200)}** to **${user.username}**.`,
    });
}

async function listTasks(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelOnly = interaction.options.getBoolean("channel_only") ?? false;
    const openOnly = interaction.options.getBoolean("open_only") ?? true;
    const limit = interaction.options.getInteger("limit") ?? DEFAULT_LIMIT;

    await interaction.deferReply();

    const tasks = await prisma.task.findMany({
        where: {
            guildId: interaction.guildId!,
            ...(channelOnly ? { channelId: interaction.channelId } : {}),
            ...(openOnly ? { status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } } : {}),
        },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: limit,
        include: { source: { select: { discordMessageId: true, channelId: true } } },
    });

    if (tasks.length === 0) {
        await interaction.editReply(openOnly ? "No open tasks for this scope." : "No tasks saved yet.");
        return;
    }

    const embed = new EmbedBuilder().setTitle("Tasks").setColor(0xfee75c).setTimestamp();
    const lines = tasks.map((t) => {
        const meta = [statusIcon(t.status)];
        if (t.assignee) meta.push(`👤 ${t.assignee}`);
        if (t.dueDate) meta.push(`📅 <t:${Math.floor(t.dueDate.getTime() / 1000)}:d>`);
        const link = t.source
            ? ` - [source](https://discord.com/channels/${interaction.guildId}/${t.source.channelId}/${t.source.discordMessageId})`
            : "";
        return `${meta.join(" ")} ${truncate(t.title, 160)}${link}`;
    });
    embed.setDescription(lines.join("\n").slice(0, 4000));
    await interaction.editReply({ embeds: [embed] });
}

function formatChoiceLabel(t: {
    title: string;
    status: TaskStatus;
    assignee: string | null;
    dueDate: Date | null;
}): string {
    const parts: string[] = [statusIcon(t.status), t.title];
    if (t.assignee) parts.push(`(${t.assignee})`);
    if (t.dueDate) parts.push(`· ${t.dueDate.toISOString().slice(0, 10)}`);
    return parts.join(" ");
}

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
