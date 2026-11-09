import {
    type AutocompleteInteraction,
    type ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { prisma } from "../db/prisma";
import type { ContextCommand } from "../services/command.service";

const AUTOCOMPLETE_LIMIT = 25;
const DEFAULT_LIMIT = 10;

const command: ContextCommand = {
    data: new SlashCommandBuilder()
        .setName("question")
        .setDescription("Manage open questions captured by ContextBot.")
        .addSubcommand((sub) =>
            sub
                .setName("resolve")
                .setDescription("Mark an open question as resolved so it stops appearing in /catchup.")
                .addStringOption((opt) =>
                    opt
                        .setName("id")
                        .setDescription("The question to resolve.")
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName("reopen")
                .setDescription("Reopen a previously-resolved question.")
                .addStringOption((opt) =>
                    opt
                        .setName("id")
                        .setDescription("The question to reopen.")
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName("list")
                .setDescription("List recent open questions in this server.")
                .addBooleanOption((opt) =>
                    opt.setName("channel_only").setDescription("Only show questions from this channel."),
                )
                .addBooleanOption((opt) =>
                    opt.setName("include_resolved").setDescription("Include resolved questions."),
                )
                .addIntegerOption((opt) =>
                    opt
                        .setName("limit")
                        .setDescription(`Max items to show (default ${DEFAULT_LIMIT}, max 25).`)
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
        if (sub === "resolve") return setResolved(interaction, true);
        if (sub === "reopen") return setResolved(interaction, false);
        if (sub === "list") return listQuestions(interaction);
    },

    async autocomplete(interaction: AutocompleteInteraction) {
        if (!interaction.guildId) {
            await interaction.respond([]);
            return;
        }
        const focused = interaction.options.getFocused(true);
        if (focused.name !== "id") {
            await interaction.respond([]);
            return;
        }
        const sub = interaction.options.getSubcommand();
        const wantResolved = sub === "reopen";
        const query = focused.value.trim();

        const rows = await prisma.openQuestion.findMany({
            where: {
                guildId: interaction.guildId,
                resolved: wantResolved,
                ...(query.length > 0 ? { text: { contains: query, mode: "insensitive" } } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: AUTOCOMPLETE_LIMIT,
            select: { id: true, text: true },
        });

        await interaction.respond(
            rows.map((r) => ({ name: truncate(r.text, 100), value: r.id })),
        );
    },
};

async function setResolved(interaction: ChatInputCommandInteraction, resolved: boolean): Promise<void> {
    const id = interaction.options.getString("id", true);
    const row = await prisma.openQuestion.findUnique({ where: { id } });
    if (!row || row.guildId !== interaction.guildId) {
        await interaction.reply({ content: "Question not found in this server.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (row.resolved === resolved) {
        await interaction.reply({
            content: resolved ? "That question is already resolved." : "That question is already open.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    const updated = await prisma.openQuestion.update({
        where: { id },
        data: {
            resolved,
            resolvedAt: resolved ? new Date() : null,
            resolvedById: resolved ? interaction.user.id : null,
        },
    });
    await interaction.reply({
        content: resolved
            ? `✅ Resolved: **${truncate(updated.text, 200)}**`
            : `↩️ Reopened: **${truncate(updated.text, 200)}**`,
    });
}

async function listQuestions(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelOnly = interaction.options.getBoolean("channel_only") ?? false;
    const includeResolved = interaction.options.getBoolean("include_resolved") ?? false;
    const limit = interaction.options.getInteger("limit") ?? DEFAULT_LIMIT;

    await interaction.deferReply();

    const rows = await prisma.openQuestion.findMany({
        where: {
            guildId: interaction.guildId!,
            ...(channelOnly ? { channelId: interaction.channelId } : {}),
            ...(includeResolved ? {} : { resolved: false }),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { source: { select: { discordMessageId: true, channelId: true } } },
    });

    if (rows.length === 0) {
        await interaction.editReply(
            includeResolved ? "No questions saved yet." : "No open questions for this scope.",
        );
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(channelOnly ? "Open questions - this channel" : "Open questions - this server")
        .setColor(0xeb459e)
        .setTimestamp();

    const lines = rows.map((q) => {
                const status = q.resolved ? "[resolved] " : "";
        const link = q.source
            ? ` - [source](https://discord.com/channels/${interaction.guildId}/${q.source.channelId}/${q.source.discordMessageId})`
            : "";
        return `${status} ${truncate(q.text, 180)}${link}`;
    });
    embed.setDescription(lines.join("\n").slice(0, 4000));
    await interaction.editReply({ embeds: [embed] });
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

export default command;
