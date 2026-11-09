import {
    type ChatInputCommandInteraction,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from "discord.js";
import { prisma } from "../db/prisma";
import { messageService } from "../services/message.service";
import type { ContextCommand } from "../services/command.service";

const WATCHABLE_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
] as const;

const command: ContextCommand = {
    data: new SlashCommandBuilder()
        .setName("watch")
        .setDescription("Configure which channels ContextBot analyzes.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName("add")
                .setDescription("Start analyzing messages in a channel.")
                .addChannelOption((opt) =>
                    opt
                        .setName("channel")
                        .setDescription("Channel to watch (defaults to the current channel).")
                        .addChannelTypes(...WATCHABLE_CHANNEL_TYPES),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName("remove")
                .setDescription("Stop analyzing messages in a channel.")
                .addChannelOption((opt) =>
                    opt
                        .setName("channel")
                        .setDescription("Channel to unwatch (defaults to the current channel).")
                        .addChannelTypes(...WATCHABLE_CHANNEL_TYPES),
                ),
        )
        .addSubcommand((sub) => sub.setName("list").setDescription("List watched channels in this server.")),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
            return;
        }

        const sub = interaction.options.getSubcommand();
        switch (sub) {
            case "add":
                await addWatch(interaction);
                return;
            case "remove":
                await removeWatch(interaction);
                return;
            case "list":
                await listWatched(interaction);
                return;
            default:
                await interaction.reply({ content: `Unknown subcommand: ${sub}`, flags: MessageFlags.Ephemeral });
        }
    },
};

async function addWatch(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.options.getChannel("channel") ?? interaction.channel;
    if (!channel || !("id" in channel)) {
        await interaction.reply({ content: "Could not resolve a channel.", flags: MessageFlags.Ephemeral });
        return;
    }

    await prisma.watchedChannel.upsert({
        where: { channelId: channel.id },
        create: {
            channelId: channel.id,
            guildId: interaction.guildId!,
            addedById: interaction.user.id,
        },
        update: {},
    });
    messageService.invalidateAllowList();

    await interaction.reply({
        content: `✅ Now analyzing <#${channel.id}>. Decisions, tasks and open questions will be captured automatically.`,
    });
}

async function removeWatch(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.options.getChannel("channel") ?? interaction.channel;
    if (!channel || !("id" in channel)) {
        await interaction.reply({ content: "Could not resolve a channel.", flags: MessageFlags.Ephemeral });
        return;
    }

    const result = await prisma.watchedChannel.deleteMany({
        where: { channelId: channel.id, guildId: interaction.guildId! },
    });
    messageService.invalidateAllowList();

    if (result.count === 0) {
        await interaction.reply({
            content: `<#${channel.id}> wasn't being watched.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await interaction.reply({ content: `🛑 Stopped analyzing <#${channel.id}>.` });
}

async function listWatched(interaction: ChatInputCommandInteraction): Promise<void> {
    const watched = await prisma.watchedChannel.findMany({
        where: { guildId: interaction.guildId! },
        orderBy: { createdAt: "asc" },
    });

    if (watched.length === 0) {
        await interaction.reply({
            content:
                "No channels are being watched yet. Use `/watch add` (in any channel) to start analysis there.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle("Watched channels")
        .setColor(0x5865f2)
        .setDescription(
            watched
                .map(
                    (w) =>
                        `• <#${w.channelId}> — added by <@${w.addedById}> <t:${Math.floor(
                            w.createdAt.getTime() / 1000,
                        )}:R>`,
                )
                .join("\n")
                .slice(0, 4000),
        )
        .setFooter({ text: `${watched.length} channel(s)` });

    await interaction.reply({ embeds: [embed] });
}

export default command;
