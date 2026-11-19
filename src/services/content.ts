import { HttpError } from "../lib/httpError.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

export const FRONTEND_REVALIDATE_PATH = "/api/admin/revalidate";

export interface ContentPaths {
    frontendDir: string;
    summariesDir: string;
    summariesFile: string;
    locales: readonly string[];
}

function resolveFrontendDir(): string {
    // Resolve relative to this package (src/services in dev, dist/services in prod) so the
    // working directory the server was started from doesn't matter.
    return new URL(env.FRONTEND_DIR, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

export function contentPaths(): ContentPaths {
    const frontendDir = resolveFrontendDir();
    return {
        frontendDir,
        summariesDir: `${frontendDir}/content/summaries`,
        summariesFile: `${frontendDir}/lib/summaries.ts`,
        locales: ["en", "hi"],
    };
}

/** Tells the Next.js app to revalidate summary pages after a content write. */
export async function revalidateFrontend(paths: string[]): Promise<{ revalidated: boolean; message?: string }> {
    if (!env.ADMIN_INTERNAL_SECRET) {
        return {
            revalidated: false,
            message: "ADMIN_INTERNAL_SECRET is not configured, so the site was not revalidated.",
        };
    }

    const origin = env.CLIENT_URL[0] ?? "http://localhost:3000";
    try {
        const res = await fetch(`${origin}${FRONTEND_REVALIDATE_PATH}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-admin-secret": env.ADMIN_INTERNAL_SECRET,
            },
            body: JSON.stringify({ paths }),
        });
        if (!res.ok) {
            return { revalidated: false, message: `The site returned ${res.status} when asked to revalidate.` };
        }
        return { revalidated: true };
    } catch (err) {
        console.error("Revalidation request failed", err);
        return { revalidated: false, message: "Could not reach the site to revalidate it." };
    }
}

/** Loads the admin's display name, used for the audit log. */
export async function adminIdentity(id: string): Promise<{ id: string; name: string }> {
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!user) throw new HttpError(401, "User no longer exists");
    return user;
}
