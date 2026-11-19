import { Router, type Request } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import type { Prisma, Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { recordAdminAction } from "../services/audit.js";

export const adminUsersRouter = Router();

const roleSchema = z.enum(["USER", "ADMIN"]);

function pagination(req: Request, defaultLimit = 20, maxLimit = 100) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defaultLimit));
    return { page, limit, skip: (page - 1) * limit };
}

const userSelect = {
    id: true,
    name: true,
    email: true,
    role: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    deletedBy: true,
    _count: { select: { comments: true } },
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

function toRow(user: UserRow) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        deletedAt: user.deletedAt,
        deletedBy: user.deletedBy,
        commentCount: user._count.comments,
        status: user.deletedAt ? "SUSPENDED" : "ACTIVE",
    };
}

async function loadAdmin(req: Request) {
    if (!req.user) throw new HttpError(401, "Not authenticated");
    const admin = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, role: true } });
    if (!admin) throw new HttpError(401, "Admin account no longer exists");
    return admin;
}

async function loadTarget(id: string) {
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, deletedAt: true } });
    if (!target) throw new HttpError(404, "User not found");
    return target;
}

async function assertAnotherAdminRemains(excludeId: string) {
    const admins = await prisma.user.count({ where: { role: "ADMIN", deletedAt: null, id: { not: excludeId } } });
    if (admins === 0) throw new HttpError(409, "At least one active admin must remain");
}

adminUsersRouter.get("/", async (req, res) => {
    const { page, limit, skip } = pagination(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const role = roleSchema.safeParse(req.query.role);
    const status = req.query.status === "suspended" || req.query.status === "all" ? req.query.status : "active";

    const where: Prisma.UserWhereInput = {
        ...(q
            ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] }
            : {}),
        ...(role.success ? { role: role.data } : {}),
        ...(status === "suspended"
            ? { NOT: { deletedAt: null } }
            : status === "active"
              ? { deletedAt: null }
              : {}),
    };

    const [rows, total] = await Promise.all([
        prisma.user.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit, select: userSelect }),
        prisma.user.count({ where }),
    ]);

    res.json({ users: rows.map(toRow), page, limit, total });
});

adminUsersRouter.get("/:id", async (req, res) => {
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!user) return res.status(404).json({ message: "User not found" });

    const [progressEntries, recentComments] = await Promise.all([
        prisma.exerciseProgress.count({ where: { userId: id } }),
        prisma.comment.findMany({
            where: { userId: id },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, summarySlug: true, body: true, createdAt: true, deletedAt: true },
        }),
    ]);
    res.json({ user: toRow(user), progressEntries, recentComments });
});

adminUsersRouter.patch("/:id", async (req, res) => {
    const admin = await loadAdmin(req);
    const id = req.params.id as string;
    const body = z
        .object({
            role: roleSchema.optional(),
            name: z.string().trim().min(2).max(60).optional(),
        })
        .refine((value) => value.role !== undefined || value.name !== undefined, { message: "Nothing to update" })
        .safeParse(req.body);
    if (!body.success) {
        return res.status(400).json({ message: "Validation failed", errors: z.flattenError(body.error).fieldErrors });
    }

    const target = await loadTarget(id);
    const roleChanged = body.data.role !== undefined && body.data.role !== target.role;
    if (roleChanged) {
        if (target.id === admin.id) return res.status(403).json({ message: "You cannot change your own role" });
        if (target.role === "ADMIN") await assertAnotherAdminRemains(target.id);
    }

    const user = await prisma.user.update({
        where: { id },
        data: {
            ...(body.data.role ? { role: body.data.role as Role } : {}),
            ...(body.data.name ? { name: body.data.name } : {}),
        },
        select: userSelect,
    });

    if (roleChanged) {
        await recordAdminAction({
            admin,
            action: "user.role_changed",
            target: "user",
            targetId: id,
            details: { email: target.email, from: target.role, to: body.data.role },
        });
    }
    res.json({ user: toRow(user) });
});

adminUsersRouter.post("/:id/reset-password", async (req, res) => {
    const admin = await loadAdmin(req);
    const id = req.params.id as string;
    const body = z.object({ password: z.string().min(8).max(128) }).safeParse(req.body);
    if (!body.success) {
        return res.status(400).json({ message: "Validation failed", errors: z.flattenError(body.error).fieldErrors });
    }

    const target = await loadTarget(id);
    await prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(body.data.password, 12) } });
    await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await recordAdminAction({ admin, action: "user.password_reset", target: "user", targetId: id, details: { email: target.email } });
    res.json({ ok: true });
});

adminUsersRouter.post("/:id/revoke-sessions", async (req, res) => {
    const admin = await loadAdmin(req);
    const id = req.params.id as string;
    const target = await loadTarget(id);

    const { count } = await prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
    });
    await recordAdminAction({
        admin,
        action: "user.sessions_revoked",
        target: "user",
        targetId: id,
        details: { email: target.email, count },
    });
    res.json({ revoked: count });
});

adminUsersRouter.post("/:id/suspend", async (req, res) => {
    const admin = await loadAdmin(req);
    const id = req.params.id as string;
    if (id === admin.id) throw new HttpError(403, "You cannot suspend your own account");

    const target = await loadTarget(id);
    if (target.deletedAt) throw new HttpError(409, "User is already suspended");
    if (target.role === "ADMIN") await assertAnotherAdminRemains(target.id);

    const now = new Date();
    const [user] = await Promise.all([
        prisma.user.update({ where: { id }, data: { deletedAt: now, deletedBy: admin.id }, select: userSelect }),
        prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } }),
    ]);
    await recordAdminAction({ admin, action: "user.suspended", target: "user", targetId: id, details: { email: target.email } });
    res.json({ user: toRow(user) });
});

adminUsersRouter.post("/:id/restore", async (req, res) => {
    const admin = await loadAdmin(req);
    const id = req.params.id as string;
    const target = await loadTarget(id);
    if (!target.deletedAt) throw new HttpError(409, "User is not suspended");

    const user = await prisma.user.update({
        where: { id },
        data: { deletedAt: null, deletedBy: null },
        select: userSelect,
    });
    await recordAdminAction({ admin, action: "user.restored", target: "user", targetId: id, details: { email: target.email } });
    res.json({ user: toRow(user) });
});
