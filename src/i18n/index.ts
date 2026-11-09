import { Locale } from "discord.js";
import { da } from "./strings/da";
import { en, type StringKey } from "./strings/en";

/**
 * Supported user-facing UI locales. Discord's full locale list is much larger; we map any
 * unknown locale to the default pack. To add a language, drop a new file under `strings/`
 * and add an entry here. TypeScript will complain if the new file is missing keys.
 */
const PACKS: Record<string, Record<StringKey, string>> = {
    [Locale.Danish]: da,
    [Locale.EnglishUS]: en,
    [Locale.EnglishGB]: en,
};

const DEFAULT_PACK = en;

export type Vars = Record<string, string | number>;

/**
 * Translate a key for a given Discord locale. Falls back to the default pack (English) for
 * unknown locales. Replacement vars are interpolated as `{name}` placeholders.
 *
 *   t("catchup.title", interaction.locale, { hours: 24 })  // "Catchup — last 24h"
 */
export function t(key: StringKey, locale: Locale | string | null | undefined, vars?: Vars): string {
    const pack = (locale && PACKS[locale]) || DEFAULT_PACK;
    const template = pack[key] ?? DEFAULT_PACK[key] ?? key;
    return interpolate(template, vars);
}

function interpolate(template: string, vars: Vars | undefined): string {
    if (!vars) return template;
    let out = template;
    for (const [name, value] of Object.entries(vars)) {
        out = out.replace(new RegExp(`\\{${escapeRegex(name)}\\}`, "g"), String(value));
    }
    return out;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the localization payload for `setDescriptionLocalizations` on a SlashCommandBuilder.
 * Discord shows the description in the slash command UI in each user's language.
 */
export function descriptionLocalizations(key: StringKey, vars?: Vars): Record<string, string> {
    return {
        [Locale.Danish]: interpolate(da[key], vars),
    };
}
