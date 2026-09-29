import type { NextFunction, Request, Response } from "express";
import { ACCESS_COOKIE, verifyAccessToken } from "../lib/tokens.js";

export function authenticate(req: Request, res: Response, next: NextFunction) {
    const token: unknown = req.cookies?.[ACCESS_COOKIE];
    if (typeof token !== "string" || !token) {
        return res.status(401).json({ message: "Not authenticated" });
    }

    try {
        const payload = verifyAccessToken(token);
        req.user = { id: payload.sub, role: payload.role };
        next();
    } catch {
        return res.status(401).json({ message: "Invalid or expired access token" });
    }
}
