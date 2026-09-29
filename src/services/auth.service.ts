import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { User } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/httpError.js";
import {
    generateRefreshToken,
    hashRefreshToken,
    refreshTokenExpiry,
    signAccessToken,
} from "../lib/tokens.js";

export type PublicUser = Omit<User, "passwordHash">;

export interface AuthResult {
    user: PublicUser;
    accessToken: string;
    refreshToken: string;
    refreshExpiresAt: Date;
}

const BCRYPT_ROUNDS = 12;

export function toPublicUser(user: User): PublicUser {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
}

async function issueTokens(user: User, familyId: string = crypto.randomUUID()): Promise<AuthResult> {
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = refreshTokenExpiry();

    await prisma.refreshToken.create({
        data: {
            tokenHash: hashRefreshToken(refreshToken),
            familyId,
            userId: user.id,
            expiresAt: refreshExpiresAt,
            // MongoDB: `revokedAt: null` filters only match an explicit null, not a missing field.
            revokedAt: null,
        },
    });

    return {
        user: toPublicUser(user),
        accessToken: signAccessToken({ sub: user.id, role: user.role }),
        refreshToken,
        refreshExpiresAt,
    };
}

export async function register(input: { name: string; email: string; password: string }): Promise<AuthResult> {
    const email = input.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
        throw new HttpError(409, "An account with this email already exists");
    }

    const user = await prisma.user.create({
        data: {
            name: input.name,
            email,
            passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
        },
    });

    return issueTokens(user);
}

export async function login(input: { email: string; password: string }): Promise<AuthResult> {
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    const valid = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
    if (!user || !valid) {
        throw new HttpError(401, "Invalid email or password");
    }
    return issueTokens(user);
}

export async function refresh(presentedToken: string): Promise<AuthResult> {
    const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashRefreshToken(presentedToken) },
        include: { user: true },
    });

    if (!stored) {
        throw new HttpError(401, "Invalid refresh token");
    }

    if (stored.revokedAt) {
        // A revoked token being presented again means it was likely stolen: kill the whole session family.
        await prisma.refreshToken.updateMany({
            where: { familyId: stored.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        throw new HttpError(401, "Refresh token reuse detected");
    }

    if (stored.expiresAt <= new Date()) {
        throw new HttpError(401, "Refresh token expired");
    }

    const { count } = await prisma.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
    });
    if (count === 0) {
        throw new HttpError(401, "Refresh token already used");
    }

    return issueTokens(stored.user, stored.familyId);
}

export async function logout(presentedToken: string | undefined): Promise<void> {
    if (!presentedToken) return;
    await prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(presentedToken), revokedAt: null },
        data: { revokedAt: new Date() },
    });
}

export async function getUserById(id: string): Promise<PublicUser | null> {
    const user = await prisma.user.findUnique({ where: { id } });
    return user ? toPublicUser(user) : null;
}
