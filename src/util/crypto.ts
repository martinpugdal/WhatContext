import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let keyCache: Buffer | null = null;

function masterKey(): Buffer {
    if (!keyCache) keyCache = Buffer.from(env.CRYPTO_KEY, "base64");
    return keyCache;
}

export function encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, masterKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(payload: string): string {
    const buf = Buffer.from(payload, "base64");
    if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
        throw new Error("ciphertext too short");
    }

    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGO, masterKey(), iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function maskKey(plaintext: string): string {
    const trimmed = plaintext.trim();
    if (trimmed.length <= 11) return "***";
    return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`;
}
