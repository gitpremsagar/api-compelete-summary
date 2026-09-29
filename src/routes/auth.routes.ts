import { Router, type Response } from "express";
import { z } from "zod";
import * as authService from "../services/auth.service.js";
import { authenticate } from "../middleware/authenticate.js";
import { validateBody } from "../middleware/validate.js";
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from "../lib/tokens.js";

const registerSchema = z.object({
    name: z.string().trim().min(2).max(60),
    email: z.email().trim(),
    password: z.string().min(8).max(128),
});

const loginSchema = z.object({
    email: z.email().trim(),
    password: z.string().min(1),
});

function sendAuth(res: Response, result: authService.AuthResult, status = 200) {
    setAuthCookies(res, result.accessToken, result.refreshToken, result.refreshExpiresAt);
    res.status(status).json({ user: result.user });
}

function readRefreshCookie(cookies: Record<string, unknown> | undefined): string | undefined {
    const value = cookies?.[REFRESH_COOKIE];
    return typeof value === "string" && value ? value : undefined;
}

export const authRouter = Router();

authRouter.post("/register", validateBody(registerSchema), async (req, res) => {
    const result = await authService.register(req.body);
    sendAuth(res, result, 201);
});

authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
    const result = await authService.login(req.body);
    sendAuth(res, result);
});

authRouter.post("/refresh", async (req, res) => {
    const token = readRefreshCookie(req.cookies);
    if (!token) {
        clearAuthCookies(res);
        return res.status(401).json({ message: "No refresh token" });
    }

    try {
        const result = await authService.refresh(token);
        sendAuth(res, result);
    } catch (err) {
        clearAuthCookies(res);
        throw err;
    }
});

authRouter.post("/logout", async (req, res) => {
    await authService.logout(readRefreshCookie(req.cookies));
    clearAuthCookies(res);
    res.status(204).end();
});

authRouter.get("/me", authenticate, async (req, res) => {
    const user = await authService.getUserById(req.user!.id);
    if (!user) {
        return res.status(401).json({ message: "User no longer exists" });
    }
    res.json({ user });
});
