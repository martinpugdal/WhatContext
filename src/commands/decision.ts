import {
    type AutocompleteInteraction,
    type ChatInputCommandInteraction,
    MessageFlags,
    SlashCommandBuilder,
} from "discord.js";
import { prisma } from "../db/prisma";
import type { ContextCommand } from "../services/command.service";

const AUTOCOMPLETE_LIMIT = 25;

const command: ContextCommand = {
    data: new SlashCommandBuilder()
        .setName("decision")
        .setDescription("Manage decisions captured by ContextBot.")
        .addSubcommand((sub) =>
            sub
                .setName("supersede")
                .setDescription("Mark a decision as superseded so it stops appearing in /catchup and /decisions.")
                .addStringOption((opt) =>
                    opt
                        .setName("id")
                        .setDescription("The decision to supersede.")
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName("restore")
                .setDescription("Undo a supersede — bring a previously-superseded decision back into the list.")
                .addStringOption((opt) =>
                    opt
                        .setName("id")
                        .setDescription("The decision to restore.")
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
            return;
        }
        const sub = interaction.options.getSubcommand();
        if (sub === "supersede") return supersede(interaction);
        if (sub === "restore") return restore(interaction);
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
        const wantSuperseded = sub === "restore";
        const query = focused.value.trim();

        const rows = await prisma.decision.findMany({
            where: {
                guildId: interaction.guildId,
                supersededAt: wantSuperseded ? { not: null } : null,
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

async function supersede(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString("id", true);
    const row = await prisma.decision.findUnique({ where: { id } });
    if (!row || row.guildId !== interaction.guildId) {
        await interaction.reply({ content: "Decision not found in this server.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (row.supersededAt) {
        await interaction.reply({
            content: `That decision was already superseded <t:${Math.floor(row.supersededAt.getTime() / 1000)}:R>.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    const updated = await prisma.decision.update({
        where: { id },
        data: { supersededAt: new Date(), supersededById: interaction.user.id },
    });
    await interaction.reply({
        content: `🚫 Marked as superseded: **${truncate(updated.text, 200)}**`,
    });
}

async function restore(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString("id", true);
    const row = await prisma.decision.findUnique({ where: { id } });
    if (!row || row.guildId !== interaction.guildId) {
        await interaction.reply({ content: "Decision not found in this server.", flags: MessageFlags.Ephemeral });
        return;
    }
    if (!row.supersededAt) {
        await interaction.reply({
            content: "That decision wasn't superseded — nothing to restore.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    const updated = await prisma.decision.update({
        where: { id },
        data: { supersededAt: null, supersededById: null },
    });
    await interaction.reply({ content: `↩️ Restored: **${truncate(updated.text, 200)}**` });
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

export default command;
