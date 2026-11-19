import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

/**
 * Creates (or promotes) the first admin account.
 *
 *   npm run seed:admin                              # uses ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD
 *   npm run seed:admin -- admin@example.com         # prompts for a password (blank = generated)
 *   npm run seed:admin -- admin@example.com "Pass1!" # for scripted setups only
 *
 * Re-running is safe: an existing account is promoted to ADMIN and, if an account was suspended, restored.
 * The password is only changed when you supply one; otherwise the account keeps its password.
 */

const BCRYPT_ROUNDS = 12;

function generatePassword(): string {
    // Readable but strong: 4 groups of 4 characters plus a digit and a symbol.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const pick = () => alphabet[crypto.randomInt(alphabet.length)];
    const groups = Array.from({ length: 4 }, () => Array.from({ length: 4 }, pick).join(""));
    return `${groups.join("-")}!7`;
}

async function promptPassword(): Promise<string | undefined> {
    if (!process.stdin.isTTY) return undefined;
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question("Password (leave blank to generate one): ");
        return answer.trim() || undefined;
    } finally {
        rl.close();
    }
}

async function main() {
    const email = (process.argv[2] ?? process.env.ADMIN_SEED_EMAIL ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
        console.error("Usage: npm run seed:admin -- <email> [password]  (or set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD)");
        process.exit(1);
    }

    const supplied = process.argv[3] ?? process.env.ADMIN_SEED_PASSWORD;
    const password = supplied ?? (await promptPassword()) ?? generatePassword();
    if (password.length < 8) {
        console.error("Password must be at least 8 characters.");
        process.exit(1);
    }

    const prisma = new PrismaClient();
    try {
        const existing = await prisma.user.findUnique({ where: { email } });

        if (existing) {
            const user = await prisma.user.update({
                where: { email },
                data: {
                    role: "ADMIN",
                    deletedAt: null,
                    deletedBy: null,
                    ...(supplied ? { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) } : {}),
                },
            });
            if (supplied) {
                await prisma.refreshToken.updateMany({
                    where: { userId: user.id, revokedAt: null },
                    data: { revokedAt: new Date() },
                });
            }
            console.log(`Existing account ${user.email} is ADMIN.`);
            console.log(supplied ? "Password reset; its other sessions were signed out." : "Password left unchanged (none was supplied).");
            return;
        }

        const name = process.env.ADMIN_SEED_NAME?.trim() || "Administrator";
        const user = await prisma.user.create({
            data: {
                name,
                email,
                passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
                role: "ADMIN",
            },
        });
        console.log(`Created admin ${user.email} (${user.name}).`);
        console.log(`Password: ${password}`);
        if (!supplied) console.log("Save this password now: it is only stored as a hash.");
    } finally {
        await prisma.$disconnect();
    }
}

await main();
