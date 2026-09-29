import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { validateBody } from "../middleware/validate.js";

const MAX_DATA_BYTES = 32 * 1024;

const paramSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);

const putSchema = z.object({
    data: z.json().refine((value) => JSON.stringify(value).length <= MAX_DATA_BYTES, {
        message: `Progress data must be at most ${MAX_DATA_BYTES} bytes`,
    }),
});

function validateParams(...names: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        for (const name of names) {
            if (!paramSchema.safeParse(req.params[name]).success) {
                return res.status(400).json({ message: `Invalid ${name}` });
            }
        }
        next();
    };
}

export const progressRouter = Router();

progressRouter.use(authenticate);

progressRouter.get("/", async (req, res) => {
    const rows = await prisma.exerciseProgress.findMany({
        where: { userId: req.user!.id },
        select: { summarySlug: true, exerciseKey: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
    });

    const bySummary = new Map<string, { slug: string; exercises: string[]; updatedAt: Date }>();
    for (const row of rows) {
        const entry = bySummary.get(row.summarySlug);
        if (entry) {
            entry.exercises.push(row.exerciseKey);
        } else {
            bySummary.set(row.summarySlug, {
                slug: row.summarySlug,
                exercises: [row.exerciseKey],
                updatedAt: row.updatedAt,
            });
        }
    }

    res.json({ summaries: [...bySummary.values()] });
});

progressRouter.get("/:slug", validateParams("slug"), async (req, res) => {
    const rows = await prisma.exerciseProgress.findMany({
        where: { userId: req.user!.id, summarySlug: req.params.slug as string },
        select: { exerciseKey: true, data: true },
    });
    res.json({ progress: Object.fromEntries(rows.map((r) => [r.exerciseKey, r.data])) });
});

progressRouter.put(
    "/:slug/:exerciseKey",
    validateParams("slug", "exerciseKey"),
    validateBody(putSchema),
    async (req, res) => {
        const userId = req.user!.id;
        const summarySlug = req.params.slug as string;
        const exerciseKey = req.params.exerciseKey as string;
        const data = req.body.data as Prisma.InputJsonValue;

        await prisma.exerciseProgress.upsert({
            where: { userId_summarySlug_exerciseKey: { userId, summarySlug, exerciseKey } },
            create: { userId, summarySlug, exerciseKey, data },
            update: { data },
        });
        res.status(204).end();
    },
);

progressRouter.delete("/:slug/:exerciseKey", validateParams("slug", "exerciseKey"), async (req, res) => {
    await prisma.exerciseProgress.deleteMany({
        where: {
            userId: req.user!.id,
            summarySlug: req.params.slug as string,
            exerciseKey: req.params.exerciseKey as string,
        },
    });
    res.status(204).end();
});
