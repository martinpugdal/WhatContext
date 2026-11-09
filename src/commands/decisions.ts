import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { prisma } from "../db/prisma";
import { descriptionLocalizations, t } from "../i18n";
import type { ContextCommand } from "../services/command.service";

const DEFAULT_LIMIT = 10;

const command: ContextCommand = {
    data: new SlashCommandBuilder()
        .setName("decisions")
        .setDescription(t("decisions.cmd.description", null))
        .setDescriptionLocalizations(descriptionLocalizations("decisions.cmd.description"))
        .addBooleanOption((opt) =>
            opt
                .setName("channel_only")
                .setDescription(t("decisions.opt.channelOnly", null))
                .setDescriptionLocalizations(descriptionLocalizations("decisions.opt.channelOnly")),
        )
        .addBooleanOption((opt) =>
            opt
                .setName("include_superseded")
                .setDescription(t("decisions.opt.includeSuperseded", null))
                .setDescriptionLocalizations(descriptionLocalizations("decisions.opt.includeSuperseded")),
        )
        .addIntegerOption((opt) =>
            opt
                .setName("limit")
                .setDescription(t("decisions.opt.limit", null, { default: DEFAULT_LIMIT }))
                .setDescriptionLocalizations(
                    descriptionLocalizations("decisions.opt.limit", { default: DEFAULT_LIMIT }),
                )
                .setMinValue(1)
                .setMaxValue(25),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
            return;
        }

        const channelOnly = interaction.options.getBoolean("channel_only") ?? false;
        const includeSuperseded = interaction.options.getBoolean("include_superseded") ?? false;
        const limit = interaction.options.getInteger("limit") ?? DEFAULT_LIMIT;

        await interaction.deferReply();

        const decisions = await prisma.decision.findMany({
            where: {
                guildId: interaction.guildId,
                ...(channelOnly ? { channelId: interaction.channelId } : {}),
                ...(includeSuperseded ? {} : { supersededAt: null }),
            },
            orderBy: { createdAt: "desc" },
            take: limit,
            include: { source: { select: { discordMessageId: true, channelId: true, authorUsername: true } } },
        });

        if (decisions.length === 0) {
            await interaction.editReply(
                channelOnly
                    ? "No decisions saved for this channel yet."
                    : "No decisions saved for this server yet.",
            );
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(channelOnly ? "Decisions - this channel" : "Decisions - this server")
            .setColor(0x57f287)
            .setTimestamp();

        const lines = decisions.map((d) => {
            const link = d.source
                ? ` - [source](https://discord.com/channels/${interaction.guildId}/${d.source.channelId}/${d.source.discordMessageId})`
                : "";
            const ts = `<t:${Math.floor(d.createdAt.getTime() / 1000)}:R>`;
            const status = d.supersededAt ? "[superseded] " : "";
            return `${status}- ${truncate(d.text, 180)}${link} ${ts}`;
        });

        embed.setDescription(lines.join("\n").slice(0, 4000));
        await interaction.editReply({ embeds: [embed] });
    },
};

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

export default command;
