import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { requireRole } from "../middleware/requireRole.js";

export const adminRouter = Router();

adminRouter.use(authenticate, requireRole("ADMIN"));

adminRouter.get("/users", async (_req, res) => {
    const users = await prisma.user.findMany({
        select: { id: true, name: true, email: true, role: true, createdAt: true },
        orderBy: { createdAt: "desc" },
    });
    res.json({ users });
});
