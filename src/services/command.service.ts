import type {
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { Collection, REST, Routes } from "discord.js";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { env } from "../config/env";

export interface ContextCommand {
    data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
    enabled?: boolean;
    execute(interaction: ChatInputCommandInteraction): Promise<void>;
    autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

export type CommandCollection = Collection<string, ContextCommand>;

export const commandService = {
    async loadCommands(): Promise<CommandCollection> {
        const commands: CommandCollection = new Collection();
        const dir = join(__dirname, "..", "commands");

        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const ext = extname(entry.name);
            if (ext !== ".ts" && ext !== ".js") continue;

            const mod = await import(join(dir, entry.name));
            const command: ContextCommand | undefined = mod.default;
            if (!command || command.enabled === false) continue;
            if (!command.data || typeof command.execute !== "function") continue;

            commands.set(command.data.name, command);
        }

        return commands;
    },

    async deployCommands(commands: CommandCollection): Promise<void> {
        const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
        const body = commands.map((c) => c.data.toJSON());

        if (env.DISCORD_DEV_GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_DEV_GUILD_ID), { body });
            console.log(
                `[commandService] Deployed ${body.length} guild command(s) to dev guild ${env.DISCORD_DEV_GUILD_ID}.`,
            );
        } else {
            await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body });
            console.log(`[commandService] Deployed ${body.length} global command(s).`);
        }
    },
};
