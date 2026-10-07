import type { NextFunction, Request, Response } from "express";
import { ACCESS_COOKIE, verifyAccessToken } from "../lib/tokens.js";

/** Sets `req.user` when a valid access token is present, but never rejects the request. */
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
    const token: unknown = req.cookies?.[ACCESS_COOKIE];
    if (typeof token === "string" && token) {
        try {
            const payload = verifyAccessToken(token);
            req.user = { id: payload.sub, role: payload.role };
        } catch {
            // Treat an invalid or expired token as anonymous.
        }
    }
    next();
}
