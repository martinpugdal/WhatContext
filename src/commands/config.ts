import {
    ActionRowBuilder,
    type ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    type ModalSubmitInteraction,
    PermissionFlagsBits,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import {
    aiServiceForGuild,
    buildOpenAiTestService,
    invalidateAiServiceCache,
    NoLlmConfigError,
} from "../services/ai.service";
import type { ContextCommand } from "../services/command.service";
import { decrypt, encrypt, maskKey } from "../util/crypto";

const MODAL_ID = "config:set-api-key";
const MODAL_FIELD_KEY = "api-key";
const MODAL_FIELD_MODEL = "model-override";
const MODAL_FIELD_BASE_URL = "base-url";
const LANGUAGE_MODAL_ID = "config:set-language";
const LANGUAGE_MODAL_FIELD = "language";

const command: ContextCommand = {
    data: new SlashCommandBuilder()
        .setName("config")
        .setDescription("Configure ContextBot's LLM provider for this server.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName("api-key")
                .setDescription(
                    "Set the API key (OpenAI or any OpenAI-compatible provider) — opens a private form.",
                ),
        )
        .addSubcommand((sub) => sub.setName("show").setDescription("Show this server's LLM config."))
        .addSubcommand((sub) =>
            sub
                .setName("test")
                .setDescription("Send a tiny test request to verify the configured key works."),
        )
        .addSubcommand((sub) =>
            sub
                .setName("language")
                .setDescription(
                    "Override the language ContextBot replies in (e.g. 'Danish', 'English', 'auto').",
                ),
        )
        .addSubcommand((sub) =>
            sub.setName("reset").setDescription("Delete the stored API key for this server."),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
            return;
        }

        const sub = interaction.options.getSubcommand();
        switch (sub) {
            case "api-key":
                await openApiKeyModal(interaction);
                return;
            case "language":
                await openLanguageModal(interaction);
                return;
            case "show":
                await showConfig(interaction);
                return;
            case "test":
                await testProvider(interaction);
                return;
            case "reset":
                await resetConfig(interaction);
                return;
        }
    },
};

async function openLanguageModal(interaction: ChatInputCommandInteraction): Promise<void> {
    const modal = new ModalBuilder().setCustomId(LANGUAGE_MODAL_ID).setTitle("Set output language");
    const langInput = new TextInputBuilder()
        .setCustomId(LANGUAGE_MODAL_FIELD)
        .setLabel("Language (e.g. 'Danish', 'English', 'auto')")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(40)
        .setPlaceholder("auto");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(langInput));
    await interaction.showModal(modal);
}

export async function handleLanguageModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) {
        await interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        return;
    }
    const raw = interaction.fields.getTextInputValue(LANGUAGE_MODAL_FIELD).trim();
    const normalized = raw.length === 0 || raw.toLowerCase() === "auto" ? null : raw;

    await prisma.guildConfig.upsert({
        where: { guildId: interaction.guildId },
        create: {
            guildId: interaction.guildId,
            outputLanguage: normalized,
            updatedById: interaction.user.id,
        },
        update: {
            outputLanguage: normalized,
            updatedById: interaction.user.id,
        },
    });
    invalidateAiServiceCache(interaction.guildId);

    await interaction.reply({
        content: normalized
            ? `✅ Output language set to **${normalized}**. Future AI responses for this server will be written in ${normalized}.`
            : "✅ Output language set to **auto** (match the input language). This is the default behavior.",
        flags: MessageFlags.Ephemeral,
    });
}

async function openApiKeyModal(interaction: ChatInputCommandInteraction): Promise<void> {
    const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle("Set LLM API key");

    const keyInput = new TextInputBuilder()
        .setCustomId(MODAL_FIELD_KEY)
        .setLabel("API key (for OpenAI)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(20)
        .setMaxLength(300)
        .setPlaceholder("sk-proj-...");

    const modelInput = new TextInputBuilder()
        .setCustomId(MODAL_FIELD_MODEL)
        .setLabel(`Model (default: ${env.OPENAI_DEFAULT_MODEL})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(64)
        .setPlaceholder(env.OPENAI_DEFAULT_MODEL);

    const baseUrlInput = new TextInputBuilder()
        .setCustomId(MODAL_FIELD_BASE_URL)
        .setLabel("Base URL (leave blank for OpenAI)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200)
        .setPlaceholder("e.g. https://api.groq.com/openai/v1");

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(modelInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(baseUrlInput),
    );

    await interaction.showModal(modal);
}

/**
 * Modal-submit dispatcher. We validate the key by pinging the provider BEFORE persisting, so
 * a typo or wrong base URL is caught immediately instead of via failing /catchup later.
 */
export async function handleApiKeyModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guildId) {
        await interaction.reply({ content: "Use this in a server.", flags: MessageFlags.Ephemeral });
        return;
    }

    const apiKey = interaction.fields.getTextInputValue(MODAL_FIELD_KEY).trim();
    const modelRaw = interaction.fields.getTextInputValue(MODAL_FIELD_MODEL).trim();
    const baseUrlRaw = interaction.fields.getTextInputValue(MODAL_FIELD_BASE_URL).trim();
    const model = modelRaw.length > 0 ? modelRaw : env.OPENAI_DEFAULT_MODEL;
    const baseUrl = baseUrlRaw.length > 0 ? baseUrlRaw : null;

    if (baseUrl && !isLikelyHttpsUrl(baseUrl)) {
        await interaction.reply({
            content: `❌ Base URL doesn't look right (\`${truncate(baseUrl, 100)}\`). It must start with \`http://\` or \`https://\`.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const probe = buildOpenAiTestService(apiKey, model, baseUrl ?? undefined);
        await probe.ping();
    } catch (err) {
        const message = redactKeyFromError(err, apiKey);
        await interaction.editReply(
            `❌ The credential didn't work: \`${truncate(message, 250)}\`\nNothing was saved.`,
        );
        return;
    }

    const ciphertext = encrypt(apiKey);
    await prisma.guildConfig.upsert({
        where: { guildId: interaction.guildId },
        create: {
            guildId: interaction.guildId,
            encryptedKey: ciphertext,
            model,
            baseUrl,
            updatedById: interaction.user.id,
        },
        update: {
            encryptedKey: ciphertext,
            model,
            baseUrl,
            updatedById: interaction.user.id,
        },
    });
    invalidateAiServiceCache(interaction.guildId);

    const target = baseUrl ? `\`${humanReadableHost(baseUrl)}\`` : "OpenAI";
    await interaction.editReply(
        `✅ Saved. ContextBot will now use ${target} with model \`${model}\` and key \`${maskKey(apiKey)}\`. The key is stored encrypted (AES-256-GCM) and never logged.`,
    );
}

async function showConfig(interaction: ChatInputCommandInteraction): Promise<void> {
    const cfg = await prisma.guildConfig.findUnique({ where: { guildId: interaction.guildId! } });

    const embed = new EmbedBuilder().setTitle("ContextBot - LLM config").setColor(0x5865f2);

    if (!cfg || !cfg.encryptedKey) {
        embed.setDescription(
            "No API key set yet. Run `/config api-key` (admin only) to add an OpenAI or OpenAI-compatible key.\n\n" +
                "**Common providers** (Base URL field in the modal):\n" +
                "- OpenAI: leave blank\n" +
                "- Groq: `https://api.groq.com/openai/v1`\n" +
                "- OpenRouter: `https://openrouter.ai/api/v1`\n" +
                "- DeepSeek: `https://api.deepseek.com/v1`",
        );
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
    }

    let keyDisplay = "***";
    try {
        keyDisplay = maskKey(decrypt(cfg.encryptedKey));
    } catch {
        keyDisplay = "_(stored, but decryption failed - re-enter via /config api-key)_";
    }

    embed.addFields(
        {
            name: "Provider",
            value: cfg.baseUrl ? `OpenAI-compatible - ${humanReadableHost(cfg.baseUrl)}` : "OpenAI",
            inline: false,
        },
        { name: "Model", value: cfg.model ?? `_(${env.OPENAI_DEFAULT_MODEL})_`, inline: true },
        { name: "API key", value: keyDisplay, inline: true },
        {
            name: "Output language",
            value: cfg.outputLanguage ?? "_auto (match input)_",
            inline: true,
        },
        {
            name: "Last updated",
            value: cfg.updatedById
                ? `<t:${Math.floor(cfg.updatedAt.getTime() / 1000)}:R> by <@${cfg.updatedById}>`
                : `<t:${Math.floor(cfg.updatedAt.getTime() / 1000)}:R>`,
            inline: false,
        },
    );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function testProvider(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const ai = await aiServiceForGuild(interaction.guildId!);
        const t0 = Date.now();
        await ai.ping();
        const ms = Date.now() - t0;
        await interaction.editReply(
            `✅ \`${ai.info.label}\` (\`${ai.info.model}\`) responded in ${ms}ms.`,
        );
    } catch (err: unknown) {
        if (err instanceof NoLlmConfigError) {
            await interaction.editReply(
                "🔑 No API key configured for this server. Run `/config api-key` to add one.",
            );
            return;
        }
        await interaction.editReply(
            `❌ Provider test failed: \`${truncate(asMessage(err), 300)}\``,
        );
    }
}

async function resetConfig(interaction: ChatInputCommandInteraction): Promise<void> {
    const existing = await prisma.guildConfig.findUnique({ where: { guildId: interaction.guildId! } });
    if (!existing || !existing.encryptedKey) {
        await interaction.reply({
            content: "Nothing to reset - no API key was saved.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await prisma.guildConfig.update({
        where: { guildId: interaction.guildId! },
        data: {
            encryptedKey: null,
            baseUrl: null,
            model: null,
            updatedById: interaction.user.id,
        },
    });
    invalidateAiServiceCache(interaction.guildId!);

    await interaction.reply({
        content: "✅ Reset. Stored API key, model and base URL have been deleted.",
        flags: MessageFlags.Ephemeral,
    });
}

function asMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return JSON.stringify(err);
}

function redactKeyFromError(err: unknown, apiKey: string): string {
    const msg = asMessage(err);
    return msg.split(apiKey).join("***REDACTED***");
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function isLikelyHttpsUrl(value: string): boolean {
    try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

function humanReadableHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

export const CONFIG_MODAL_ID = MODAL_ID;
export const CONFIG_LANGUAGE_MODAL_ID = LANGUAGE_MODAL_ID;
export default command;
