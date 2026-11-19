import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { recordAdminAction } from "../services/audit.js";
import { adminCommentsRouter } from "./admin.comments.js";
import { adminStatsRouter } from "./admin.stats.js";
import { adminSummariesRouter } from "./admin.summaries.js";
import { adminUsersRouter } from "./admin.users.js";

export const adminRouter = Router();

// Authentication runs once in server.ts, before this router is mounted.
adminRouter.use((req, _res, next) => {
    if (req.user?.role !== "ADMIN") return next(new HttpError(403, "Forbidden"));
    next();
});

adminRouter.use("/users", adminUsersRouter);
adminRouter.use("/comments", adminCommentsRouter);
adminRouter.use("/summaries", adminSummariesRouter);
adminRouter.use("/stats", adminStatsRouter);

const actionSchema = z.object({
    action: z.string().min(1).max(80),
    target: z.string().min(1).max(40),
    targetId: z.string().max(120).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
});

/** Lets the admin UI log client-side actions (exports, downloads) that have no server-side side effect. */
adminRouter.post("/activity", async (req, res) => {
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Validation failed", errors: z.flattenError(parsed.error).fieldErrors });

    const admin = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, name: true } });
    if (!admin) return res.status(401).json({ message: "Admin account no longer exists" });

    const { details, ...rest } = parsed.data;
    await recordAdminAction({
        admin,
        action: rest.action,
        target: rest.target,
        targetId: rest.targetId ?? null,
        ...(details ? { details: details as Prisma.InputJsonValue } : {}),
    });
    res.status(204).end();
});
