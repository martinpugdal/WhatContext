import { loadEnv } from "./config/env";
import { commandService } from "./services/command.service";

async function main(): Promise<void> {
    loadEnv();
    const commands = await commandService.loadCommands();
    if (commands.size === 0) {
        console.warn("[deploy-commands] No commands found.");
        return;
    }
    await commandService.deployCommands(commands);
}

main().catch((err) => {
    console.error("[deploy-commands] fatal:", err);
    process.exit(1);
});
