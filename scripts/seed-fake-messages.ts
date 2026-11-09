/**
 * Seed N fake messages into the watched channel for /catchup load-testing.
 *
 *   npx ts-node -r dotenv/config scripts/seed-fake-messages.ts
 *
 * Flags (all optional):
 *   COUNT=1000          how many messages
 *   HOURS=24            spread over the last N hours
 *   CHANNEL=<id>        target channel id (default: first WatchedChannel)
 *   GUILD=<id>          guild id; default: looked up via WatchedChannel
 *   CLEAR=1             delete all previously-seeded fake messages first
 *   DRY=1               just print summary, don't write
 */
import { Importance, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface Template {
    weight: number;
    importance: Importance | null;
    samples: string[];
}

const TEMPLATES: Template[] = [
    {
        weight: 50,
        importance: Importance.LOW,
        samples: [
            "lol",
            "haha",
            "ja",
            "ok",
            "nice",
            "🚀",
            "👍",
            "fedt",
            "klart",
            "den er god",
            "godt",
            "kk",
            "mojn",
            "hej",
            "yo",
            "hører dig",
            "skidt",
            "haha selvfølgelig",
            "nævn ikke det igen",
            "jeg forstår ikke 😅",
        ],
    },
    {
        weight: 20,
        importance: Importance.LOW,
        samples: [
            "Hvor langt nåede I i går?",
            "Skal vi mødes til frokost?",
            "Hvem har sidst rørt deploy-scriptet?",
            "Nogen der ved hvor docs ligger?",
            "Mangler vi stadig at fixe det der CSS-issue?",
            "Hvad var det vi snakkede om i går omkring caching?",
            "Hvor finder jeg PROD-credentials?",
            "Hvem ejer ingestion-pipelinen lige nu?",
            "Skal jeg lave en PR på det?",
            "Er staging oppe?",
        ],
    },
    {
        weight: 15,
        importance: Importance.MEDIUM,
        samples: [
            "Lige opdaget at users-tabellen mangler index på email-feltet, det forklarer langsom login.",
            "Frontend bygger nu under 30s efter vi droppede source-maps i CI.",
            "Bemærk: API'en returnerer 503 hvis Redis er nede, vi har ikke fallback endnu.",
            "Jeg har spike'd et POC for nyt auth-flow, ligger på branch 'spike/auth'.",
            "Migration 0042 har kørt i prod uden issues, ~3min downtime.",
            "Vi ramte rate-limit på Stripe i morges, har lagt en retry-loop ind.",
            "Tjekkede metrics — p95 latency er steget 200ms siden sidste deploy.",
            "Postgres connection-pool er sat til 20, vi rammer loft i peak.",
            "Test-coverage er nu på 73%, primært i auth- og billing-modulerne.",
            "Slack-integration er flaky, sender duplicate messages ~5% af tiden.",
        ],
    },
    {
        weight: 10,
        importance: Importance.HIGH,
        samples: [
            "Vi har besluttet at flytte fra MariaDB til PostgreSQL inden Q3.",
            "Beslutning: alle nye services skal deployes via Docker, ikke bare-metal.",
            "@martin laver database-migration til fredag d. 27. juni.",
            "Vi går videre med React 19 i stedet for at vente på Next 16.",
            "Action: @anna opdaterer onboarding-docs inden månedsskiftet.",
            "Beslutning: vi dropper REST og lægger nye endpoints på GraphQL.",
            "@peter tager ansvaret for Stripe-integrationen, deadline 1. juli.",
            "Vi standardiserer på pnpm i hele org, alle teams skal være migreret inden EOM.",
            "@sara udruller monitoring til alle k8s-clusters i næste uge.",
            "Beslutning: feature-flags styres via LaunchDarkly fra og med v2.0.",
        ],
    },
];

const FAKE_AUTHORS = [
    { id: "100000000000000001", username: "alice" },
    { id: "100000000000000002", username: "bob" },
    { id: "100000000000000003", username: "martin" },
    { id: "100000000000000004", username: "anna" },
    { id: "100000000000000005", username: "peter" },
    { id: "100000000000000006", username: "sara" },
    { id: "100000000000000007", username: "kasper" },
    { id: "100000000000000008", username: "emma" },
];

function pickWeighted<T extends { weight: number }>(items: T[]): T {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = Math.random() * total;
    for (const i of items) {
        r -= i.weight;
        if (r <= 0) return i;
    }
    return items[items.length - 1];
}

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

async function main(): Promise<void> {
    const COUNT = Number(process.env.COUNT ?? 1000);
    const HOURS = Number(process.env.HOURS ?? 24);
    const DRY = process.env.DRY === "1";
    const CLEAR = process.env.CLEAR === "1";

    let channelId = process.env.CHANNEL;
    let guildId = process.env.GUILD;

    if (!channelId || !guildId) {
        const watched = await prisma.watchedChannel.findFirst({ orderBy: { createdAt: "asc" } });
        if (!watched) {
            console.error(
                "No watched channel found. Use /watch add in Discord first, or pass CHANNEL=... GUILD=...",
            );
            process.exit(1);
        }
        channelId = channelId ?? watched.channelId;
        guildId = guildId ?? watched.guildId;
    }

    if (CLEAR) {
        const del = await prisma.message.deleteMany({ where: { discordMessageId: { startsWith: "fake-" } } });
        console.log(`[seed] Cleared ${del.count} previously-seeded fake messages.`);
    }

    const now = Date.now();
    const windowMs = HOURS * 60 * 60 * 1000;
    const seedRunId = now.toString(36);

    const rows: {
        discordMessageId: string;
        guildId: string;
        channelId: string;
        authorId: string;
        authorUsername: string;
        content: string;
        createdAt: Date;
        importance: Importance | null;
        analyzedAt: Date | null;
    }[] = [];

    const counts = { low: 0, medium: 0, high: 0, unanalyzed: 0 };

    for (let i = 0; i < COUNT; i++) {
        const tpl = pickWeighted(TEMPLATES);
        const author = pick(FAKE_AUTHORS);
        const content = pick(tpl.samples);
        const offset = Math.random() * windowMs;
        const createdAt = new Date(now - offset);
        // ~10% af beskederne er ikke analyseret endnu (mimics realistic state)
        const skipAnalyze = Math.random() < 0.1;
        const importance = skipAnalyze ? null : tpl.importance;
        if (importance === null) counts.unanalyzed++;
        else if (importance === Importance.HIGH) counts.high++;
        else if (importance === Importance.MEDIUM) counts.medium++;
        else counts.low++;

        rows.push({
            discordMessageId: `fake-${seedRunId}-${i}`,
            guildId,
            channelId,
            authorId: author.id,
            authorUsername: author.username,
            content,
            createdAt,
            importance,
            analyzedAt: importance === null ? null : createdAt,
        });
    }

    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    console.log(`[seed] Plan: ${COUNT} messages, ${HOURS}h window`);
    console.log(`[seed] Channel: ${channelId}  Guild: ${guildId}`);
    console.log(`[seed] Distribution: low=${counts.low} medium=${counts.medium} high=${counts.high} unanalyzed=${counts.unanalyzed}`);
    console.log(`[seed] Sample: "${rows[0]?.content}" — by ${rows[0]?.authorUsername}`);

    if (DRY) {
        console.log("[seed] DRY=1 — not writing.");
        return;
    }

    const t0 = Date.now();
    const result = await prisma.message.createMany({ data: rows, skipDuplicates: true });
    const ms = Date.now() - t0;
    console.log(`[seed] Inserted ${result.count} rows in ${ms}ms.`);
}

main()
    .catch((err) => {
        console.error("[seed] fatal:", err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
