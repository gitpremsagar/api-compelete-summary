import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { recordAdminAction } from "../services/audit.js";

export const adminCommentsRouter = Router();

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/);

function pagination(req: Request, defaultLimit = 20, maxLimit = 100) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defaultLimit));
    return { page, limit, skip: (page - 1) * limit };
}

async function loadAdmin(req: Request) {
    if (!req.user) throw new HttpError(401, "Not authenticated");
    const admin = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, name: true } });
    if (!admin) throw new HttpError(401, "Admin account no longer exists");
    return admin;
}

const commentSelect = {
    id: true,
    body: true,
    summarySlug: true,
    createdAt: true,
    deletedAt: true,
    user: { select: { id: true, name: true, email: true, deletedAt: true } },
} as const;
adminCommentsRouter.get("/", async (req, res) => {
    const { page, limit, skip } = pagination(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const slug = typeof req.query.slug === "string" && req.query.slug ? req.query.slug : undefined;
    const status = req.query.status === "deleted" || req.query.status === "all" ? req.query.status : "active";

    const where: Prisma.CommentWhereInput = {
        ...(q
            ? { OR: [{ body: { contains: q, mode: "insensitive" } }, { user: { is: { email: { contains: q, mode: "insensitive" } } } }] }
            : {}),
        ...(slug ? { summarySlug: slug } : {}),
        ...(status === "deleted" ? { NOT: { deletedAt: null } } : status === "active" ? { deletedAt: null } : {}),
    };

    const [rows, total] = await Promise.all([
        prisma.comment.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit, select: commentSelect }),
        prisma.comment.count({ where }),
    ]);

    res.json({
        comments: rows.map((row) => ({
            id: row.id,
            body: row.body,
            summarySlug: row.summarySlug,
            createdAt: row.createdAt,
            deletedAt: row.deletedAt,
            author: { id: row.user.id, name: row.user.name, email: row.user.email, suspended: Boolean(row.user.deletedAt) },
        })),
        page,
        limit,
        total,
    });
});

adminCommentsRouter.post("/:id/delete", async (req, res) => {
    const admin = await loadAdmin(req);
    const id = req.params.id as string;
    if (!objectIdSchema.safeParse(id).success) throw new HttpError(404, "Comment not found");

    const comment = await prisma.comment.findUnique({ where: { id }, select: { id: true, summarySlug: true, userId: true, deletedAt: true } });
    if (!comment) throw new HttpError(404, "Comment not found");
    if (comment.deletedAt) throw new HttpError(409, "Comment is already deleted");

    await prisma.comment.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: admin.id } });
    await recordAdminAction({
        admin,
        action: "comment.deleted",
        target: "comment",
        targetId: id,
        details: { summarySlug: comment.summarySlug, userId: comment.userId },
    });
    res.json({ ok: true });
});

adminCommentsRouter.post("/:id/restore", async (req, res) => {
    const admin = await loadAdmin(req);
    const id = req.params.id as string;
    if (!objectIdSchema.safeParse(id).success) throw new HttpError(404, "Comment not found");

    const comment = await prisma.comment.findUnique({ where: { id }, select: { id: true, summarySlug: true, deletedAt: true } });
    if (!comment) throw new HttpError(404, "Comment not found");
    if (!comment.deletedAt) throw new HttpError(409, "Comment is not deleted");

    await prisma.comment.update({ where: { id }, data: { deletedAt: null, deletedBy: null } });
    await recordAdminAction({
        admin,
        action: "comment.restored",
        target: "comment",
        targetId: id,
        details: { summarySlug: comment.summarySlug },
    });
    res.json({ ok: true });
});
