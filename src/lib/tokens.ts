import crypto from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { CookieOptions, Response } from "express";
import type { Role } from "@prisma/client";
import { env, isProduction } from "../config/env.js";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";
export const REFRESH_COOKIE_PATH = "/api/auth";
// Not a credential: lets the frontend route guard know a refresh token exists, since that cookie is path-scoped.
export const SESSION_HINT_COOKIE = "has_session";

export interface AccessTokenPayload {
    sub: string;
    role: Role;
}

export function signAccessToken(payload: AccessTokenPayload): string {
    return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
        expiresIn: env.ACCESS_TOKEN_TTL as NonNullable<SignOptions["expiresIn"]>,
    });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof decoded === "string" || typeof decoded.sub !== "string") {
        throw new Error("Invalid access token payload");
    }
    return { sub: decoded.sub, role: decoded.role as Role };
}

export function generateRefreshToken(): string {
    return crypto.randomBytes(64).toString("base64url");
}

export function hashRefreshToken(token: string): string {
    return crypto.createHmac("sha256", env.JWT_REFRESH_SECRET).update(token).digest("hex");
}

export function refreshTokenExpiry(): Date {
    return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

const baseCookie: CookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string, refreshExpiresAt: Date) {
    const { exp } = jwt.decode(accessToken) as { exp: number };
    res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie, path: "/", expires: new Date(exp * 1000) });
    res.cookie(REFRESH_COOKIE, refreshToken, { ...baseCookie, path: REFRESH_COOKIE_PATH, expires: refreshExpiresAt });
    res.cookie(SESSION_HINT_COOKIE, "1", { ...baseCookie, path: "/", expires: refreshExpiresAt });
}

export function clearAuthCookies(res: Response) {
    res.clearCookie(ACCESS_COOKIE, { ...baseCookie, path: "/" });
    res.clearCookie(REFRESH_COOKIE, { ...baseCookie, path: REFRESH_COOKIE_PATH });
    res.clearCookie(SESSION_HINT_COOKIE, { ...baseCookie, path: "/" });
}
