import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export interface AuditEntry {
    admin: { id: string; name: string };
    action: string;
    target: string;
    targetId?: string | null;
    details?: Prisma.InputJsonValue;
}

/** Record an admin mutation. Never throws: a failed audit write should not fail the action itself. */
export async function recordAdminAction({ admin, action, target, targetId, details }: AuditEntry): Promise<void> {
    try {
        await prisma.adminAction.create({
            data: {
                adminId: admin.id,
                adminName: admin.name,
                action,
                target,
                targetId: targetId ?? null,
                ...(details !== undefined ? { details } : {}),
            },
        });
    } catch (err) {
        console.error("Failed to record admin action", action, target, err);
    }
}
