import {
    Client,
    Collection,
    Events,
    GatewayIntentBits,
    MessageFlags,
    Options,
    Partials,
    type Interaction,
    type Message,
} from "discord.js";
import {
    CONFIG_LANGUAGE_MODAL_ID,
    CONFIG_MODAL_ID,
    handleApiKeyModalSubmit,
    handleLanguageModalSubmit,
} from "./commands/config";
import { loadEnv } from "./config/env";
import { prisma } from "./db/prisma";
import { commandService, type CommandCollection, type ContextCommand } from "./services/command.service";
import { messageService } from "./services/message.service";

declare module "discord.js" {
    interface Client {
        commands: CommandCollection;
    }
}

async function main(): Promise<void> {
    loadEnv();
    const env = loadEnv();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message],
        makeCache: Options.cacheEverything(),
        sweepers: Options.DefaultSweeperSettings,
        rest: { timeout: 30_000 },
    });
    client.commands = new Collection();

    client.on("error", (err) => console.error("[discord] client error:", err));
    client.on("shardError", (err) => console.error("[discord] shard error:", err));

    const commands = await commandService.loadCommands();
    for (const [name, command] of commands) client.commands.set(name, command);
    console.log(`[bot] Loaded ${commands.size} command(s): ${[...commands.keys()].join(", ")}`);

    client.on(Events.MessageCreate, (message: Message) => {
        messageService.ingest(message).catch((err) => console.error("[messageService] ingest failed:", err));
    });

    client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
        if (newMessage.author?.bot) return;
        const content = newMessage.content;
        if (typeof content !== "string") return;
        messageService.handleEdit(newMessage.id, content).catch((err) =>
            console.error("[messageService] edit failed:", err),
        );
    });

    client.on(Events.MessageDelete, (message) => {
        messageService.handleDelete(message.id).catch((err) =>
            console.error("[messageService] delete failed:", err),
        );
    });

    client.on(Events.InteractionCreate, async (interaction: Interaction) => {
        if (interaction.isAutocomplete()) {
            const command: ContextCommand | undefined = client.commands.get(interaction.commandName);
            if (!command?.autocomplete) return;
            try {
                await command.autocomplete(interaction);
            } catch (err) {
                console.error(`[bot] autocomplete "${interaction.commandName}" failed:`, err);
            }
            return;
        }

        if (interaction.isModalSubmit()) {
            try {
                if (interaction.customId === CONFIG_MODAL_ID) {
                    await handleApiKeyModalSubmit(interaction);
                } else if (interaction.customId === CONFIG_LANGUAGE_MODAL_ID) {
                    await handleLanguageModalSubmit(interaction);
                }
            } catch (err) {
                // Do not log field values; modal submissions may contain API keys.
                console.error(`[bot] modal "${interaction.customId}" failed:`, err);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction
                        .reply({ content: "Something went wrong handling that form.", flags: MessageFlags.Ephemeral })
                        .catch(() => {});
                }
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;
        const command: ContextCommand | undefined = client.commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction);
        } catch (err) {
            console.error(`[bot] command "${interaction.commandName}" failed:`, err);
            const content = "Something went wrong handling that command.";
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
            } else {
                await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    });

    client.once(Events.ClientReady, (c) => {
        console.log(`[bot] Logged in as ${c.user.tag}`);
        if (env.DISCORD_DEV_GUILD_ID) {
            console.log(`[bot] Dev guild: ${env.DISCORD_DEV_GUILD_ID}`);
        }
    });

    const shutdown = async (signal: string) => {
        console.log(`[bot] Received ${signal}, shutting down...`);
        try {
            await client.destroy();
        } catch (err) {
            console.error("[bot] error destroying client:", err);
        }
        try {
            await prisma.$disconnect();
        } catch (err) {
            console.error("[bot] error disconnecting prisma:", err);
        }
        process.exit(0);
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
    console.error("[bot] fatal:", err);
    process.exit(1);
});
