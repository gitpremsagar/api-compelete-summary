import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { recordAdminAction } from "../services/audit.js";

export const adminStatsRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 30;

function startOfUtcDay(date: Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

adminStatsRouter.get("/", async (_req, res) => {
    const now = new Date();
    const since = new Date(now.getTime() - TREND_DAYS * DAY_MS);
    const today = startOfUtcDay(now);
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

    const [
        totalUsers,
        newUsers7d,
        admins,
        suspendedUsers,
        totalComments,
        deletedComments,
        comments7d,
        viewsAgg,
        likes,
        dislikes,
        recentUsers,
        recentComments,
        summaryCounts,
    ] = await Promise.all([
        prisma.user.count({ where: { deletedAt: null } }),
        prisma.user.count({ where: { deletedAt: null, createdAt: { gte: weekAgo } } }),
        prisma.user.count({ where: { deletedAt: null, role: "ADMIN" } }),
        prisma.user.count({ where: { NOT: { deletedAt: null } } }),
        prisma.comment.count({ where: { deletedAt: null } }),
        prisma.comment.count({ where: { NOT: { deletedAt: null } } }),
        prisma.comment.count({ where: { deletedAt: null, createdAt: { gte: weekAgo } } }),
        prisma.summaryStats.aggregate({ _sum: { views: true } }),
        prisma.reaction.count({ where: { type: "LIKE" } }),
        prisma.reaction.count({ where: { type: "DISLIKE" } }),
        prisma.user.findMany({
            where: { deletedAt: null, createdAt: { gte: since } },
            select: { createdAt: true },
        }),
        prisma.comment.findMany({
            where: { deletedAt: null, createdAt: { gte: since } },
            select: { createdAt: true, summarySlug: true },
        }),
        prisma.summaryStats.findMany({ select: { slug: true, views: true } }),
    ]);

    const bySlugComments = await prisma.comment.groupBy({
        by: ["summarySlug"],
        where: { deletedAt: null },
        _count: { _all: true },
    });
    const bySlugLikes = await prisma.reaction.groupBy({
        by: ["summarySlug", "type"],
        _count: { _all: true },
    });

    const days: { date: string; users: number; comments: number }[] = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
        const date = new Date(today.getTime() - i * DAY_MS);
        days.push({ date: date.toISOString().slice(0, 10), users: 0, comments: 0 });
    }
    const index = new Map(days.map((day) => [day.date, day]));
    for (const user of recentUsers) {
        const key = startOfUtcDay(user.createdAt).toISOString().slice(0, 10);
        const bucket = index.get(key);
        if (bucket) bucket.users += 1;
    }
    for (const comment of recentComments) {
        const key = startOfUtcDay(comment.createdAt).toISOString().slice(0, 10);
        const bucket = index.get(key);
        if (bucket) bucket.comments += 1;
    }

    const topSlugs = new Map<string, { slug: string; views: number; likes: number; dislikes: number; comments: number }>();
    const entry = (slug: string) => {
        let row = topSlugs.get(slug);
        if (!row) {
            row = { slug, views: 0, likes: 0, dislikes: 0, comments: 0 };
            topSlugs.set(slug, row);
        }
        return row;
    };
    for (const row of summaryCounts) entry(row.slug).views = row.views;
    for (const row of bySlugComments) entry(row.summarySlug).comments = row._count._all;
    for (const row of bySlugLikes) {
        if (row.type === "LIKE") entry(row.summarySlug).likes = row._count._all;
        else entry(row.summarySlug).dislikes = row._count._all;
    }

    const topSummaries = [...topSlugs.values()]
        .sort((a, b) => b.views - a.views || b.comments - a.comments)
        .slice(0, 8);

    res.json({
        totals: {
            users: totalUsers,
            newUsers7d,
            admins,
            suspendedUsers,
            comments: totalComments,
            deletedComments,
            comments7d,
            views: viewsAgg._sum.views ?? 0,
            likes,
            dislikes,
        },
        trend: days,
        topSummaries,
    });
});

adminStatsRouter.get("/activity", async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const actions = await prisma.adminAction.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    res.json({ actions, total: await prisma.adminAction.count() });
});
