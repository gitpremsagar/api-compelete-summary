import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { ReactionType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { optionalAuthenticate } from "../middleware/optionalAuthenticate.js";
import { validateBody } from "../middleware/validate.js";

const MAX_STATS_SLUGS = 50;
const MAX_COMMENT_LENGTH = 2000;
const DEFAULT_COMMENT_PAGE = 20;
const MAX_COMMENT_PAGE = 50;

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/);

const reactionSchema = z.object({
    type: z.enum(["LIKE", "DISLIKE"]).nullable(),
});

const commentSchema = z.object({
    body: z.string().trim().min(1, "Comment cannot be empty").max(MAX_COMMENT_LENGTH),
});

interface Stats {
    views: number;
    likes: number;
    dislikes: number;
    comments: number;
}

function validateSlug(req: Request, res: Response, next: NextFunction) {
    if (!slugSchema.safeParse(req.params.slug).success) {
        return res.status(400).json({ message: "Invalid slug" });
    }
    next();
}

async function getStats(slugs: string[]): Promise<Record<string, Stats>> {
    const [views, reactions, comments] = await Promise.all([
        prisma.summaryStats.findMany({ where: { slug: { in: slugs } }, select: { slug: true, views: true } }),
        prisma.reaction.groupBy({
            by: ["summarySlug", "type"],
            where: { summarySlug: { in: slugs } },
            _count: { _all: true },
        }),
        prisma.comment.groupBy({
            by: ["summarySlug"],
            where: { summarySlug: { in: slugs } },
            _count: { _all: true },
        }),
    ]);

    const stats = new Map<string, Stats>(slugs.map((slug) => [slug, emptyStats()]));
    for (const row of views) stats.get(row.slug)!.views = row.views;
    for (const row of reactions) {
        stats.get(row.summarySlug)![row.type === "LIKE" ? "likes" : "dislikes"] = row._count._all;
    }
    for (const row of comments) stats.get(row.summarySlug)!.comments = row._count._all;
    return Object.fromEntries(stats);
}

function emptyStats(): Stats {
    return { views: 0, likes: 0, dislikes: 0, comments: 0 };
}

async function getMyReaction(userId: string | undefined, summarySlug: string): Promise<ReactionType | null> {
    if (!userId) return null;
    const reaction = await prisma.reaction.findUnique({
        where: { userId_summarySlug: { userId, summarySlug } },
        select: { type: true },
    });
    return reaction?.type ?? null;
}

type CommentRow = {
    id: string;
    body: string;
    createdAt: Date;
    user: { id: string; name: string };
};

function toCommentDto(row: CommentRow, viewer: Request["user"]) {
    return {
        id: row.id,
        body: row.body,
        createdAt: row.createdAt,
        author: { id: row.user.id, name: row.user.name },
        canDelete: Boolean(viewer && (viewer.id === row.user.id || viewer.role === "ADMIN")),
    };
}

const commentSelect = {
    id: true,
    body: true,
    createdAt: true,
    user: { select: { id: true, name: true } },
} as const;

export const engagementRouter = Router();

engagementRouter.get("/stats", async (req, res) => {
    const raw = typeof req.query.slugs === "string" ? req.query.slugs : "";
    const slugs = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (slugs.length === 0 || slugs.length > MAX_STATS_SLUGS || !slugs.every((s) => slugSchema.safeParse(s).success)) {
        return res.status(400).json({ message: "Invalid slugs" });
    }
    res.json({ stats: await getStats(slugs) });
});

engagementRouter.get("/:slug/engagement", validateSlug, optionalAuthenticate, async (req, res) => {
    const slug = req.params.slug as string;
    const [stats, myReaction] = await Promise.all([getStats([slug]), getMyReaction(req.user?.id, slug)]);
    res.json({ stats: stats[slug], myReaction });
});

engagementRouter.post("/:slug/view", validateSlug, async (req, res) => {
    const slug = req.params.slug as string;
    const row = await prisma.summaryStats.upsert({
        where: { slug },
        create: { slug, views: 1 },
        update: { views: { increment: 1 } },
        select: { views: true },
    });
    res.json({ views: row.views });
});

engagementRouter.put(
    "/:slug/reaction",
    validateSlug,
    authenticate,
    validateBody(reactionSchema),
    async (req, res) => {
        const userId = req.user!.id;
        const summarySlug = req.params.slug as string;
        const type = req.body.type as ReactionType | null;

        if (type) {
            await prisma.reaction.upsert({
                where: { userId_summarySlug: { userId, summarySlug } },
                create: { userId, summarySlug, type },
                update: { type },
            });
        } else {
            await prisma.reaction.deleteMany({ where: { userId, summarySlug } });
        }

        const stats = await getStats([summarySlug]);
        res.json({ stats: stats[summarySlug], myReaction: type });
    },
);

engagementRouter.get("/:slug/comments", validateSlug, optionalAuthenticate, async (req, res) => {
    const summarySlug = req.params.slug as string;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    if (cursor && !objectIdSchema.safeParse(cursor).success) {
        return res.status(400).json({ message: "Invalid cursor" });
    }
    const limitParam = Number(req.query.limit);
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_COMMENT_PAGE) : DEFAULT_COMMENT_PAGE;

    const rows = await prisma.comment.findMany({
        where: { summarySlug },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: commentSelect,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
        comments: page.map((row) => toCommentDto(row, req.user)),
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    });
});

engagementRouter.post(
    "/:slug/comments",
    validateSlug,
    authenticate,
    validateBody(commentSchema),
    async (req, res) => {
        const row = await prisma.comment.create({
            data: { userId: req.user!.id, summarySlug: req.params.slug as string, body: req.body.body as string },
            select: commentSelect,
        });
        res.status(201).json({ comment: toCommentDto(row, req.user) });
    },
);

engagementRouter.delete("/:slug/comments/:id", validateSlug, authenticate, async (req, res) => {
    const id = req.params.id as string;
    if (!objectIdSchema.safeParse(id).success) {
        return res.status(404).json({ message: "Comment not found" });
    }
    const comment = await prisma.comment.findUnique({ where: { id }, select: { userId: true, summarySlug: true } });
    if (!comment || comment.summarySlug !== req.params.slug) {
        return res.status(404).json({ message: "Comment not found" });
    }
    if (comment.userId !== req.user!.id && req.user!.role !== "ADMIN") {
        return res.status(403).json({ message: "You can only delete your own comments" });
    }
    await prisma.comment.delete({ where: { id } });
    res.status(204).end();
});
