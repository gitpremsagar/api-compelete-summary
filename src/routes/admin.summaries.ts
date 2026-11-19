import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/httpError.js";
import { recordAdminAction } from "../services/audit.js";
import { revalidateFrontend } from "../services/content.js";
import { contentHealth, listSummaryMetas, readSummary } from "../services/summaries.js";
import { toSummaryRow } from "../services/summary-dto.js";
import { createSummary, updateSummary } from "../services/summary-files.js";
import { summarizeMeta, validateMeta } from "../services/summary-validation.js";

export const adminSummariesRouter = Router();

const statusValues = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
type Status = (typeof statusValues)[number];

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

const payloadSchema = z.object({
    meta: z.unknown(),
    bodies: z
        .object({
            en: z.string().optional(),
            hi: z.string().optional(),
        })
        .optional()
        .default({}),
});

async function statusFor(slug: string): Promise<{ status: Status; archivedAt: Date | null }> {
    const doc = await prisma.summaryDocument.findUnique({ where: { slug } });
    return { status: (doc?.status ?? "PUBLISHED") as Status, archivedAt: doc?.archivedAt ?? null };
}

function pagePaths(slug: string) {
    return ["/", "/summaries", `/summaries/${slug}`, "/hi", "/hi/summaries", `/hi/summaries/${slug}`];
}

adminSummariesRouter.get("/", async (req, res) => {
    const { page, limit, skip } = pagination(req);
    const statusFilter: Status = statusValues.find((s) => s === req.query.status) ?? "PUBLISHED";
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

    const [metas, docs] = await Promise.all([listSummaryMetas(), prisma.summaryDocument.findMany()]);
    const docMap = new Map(docs.map((doc) => [doc.slug, doc]));

    const rows = await Promise.all(
        metas.map(async (meta) => {
            const doc = docMap.get(meta.slug);
            const record = await readSummary(meta.slug);
            record.status = (doc?.status ?? "PUBLISHED") as Status;
            record.archivedAt = doc?.archivedAt ? doc.archivedAt.toISOString() : null;
            return toSummaryRow(record);
        }),
    );

    // Archived entries whose metadata was removed from summaries.ts only exist in the DB.
    const diskSlugs = new Set(metas.map((meta) => meta.slug));
    const orphanArchives = docs
        .filter((doc) => doc.status === "ARCHIVED" && !diskSlugs.has(doc.slug))
        .map((doc) => ({
            slug: doc.slug,
            kind: "—",
            title: `${doc.slug} (metadata missing)`,
            description: "The metadata entry was removed from summaries.ts. Restore it before publishing again.",
            publishedAt: "",
            updatedAt: null,
            tags: [] as string[],
            hasHindi: false,
            wordCount: 0,
            status: "ARCHIVED",
            archivedAt: doc.archivedAt ? doc.archivedAt.toISOString() : null,
            hasBody: false,
            hasHindiBody: false,
        }));

    const counts = { PUBLISHED: 0, DRAFT: 0, ARCHIVED: 0 } satisfies Record<Status, number>;
    for (const row of [...rows, ...orphanArchives]) counts[row.status as Status] += 1;

    const filtered = [...rows, ...orphanArchives].filter((row) => row.status === statusFilter);
    const searched = q
        ? filtered.filter((row) => `${row.slug} ${row.title} ${row.description}`.toLowerCase().includes(q))
        : filtered;
    const sorted = searched.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));

    res.json({ summaries: sorted.slice(skip, skip + limit), page, limit, total: sorted.length, statusCounts: counts });
});

adminSummariesRouter.get("/health", async (_req, res) => {
    res.json(await contentHealth());
});

adminSummariesRouter.get("/:slug", async (req, res) => {
    const slug = req.params.slug as string;
    const { status, archivedAt } = await statusFor(slug);
    try {
        const record = await readSummary(slug);
        res.json({ summary: record, status, archivedAt });
    } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 404) throw err;
        if (status !== "ARCHIVED") throw err;
        res.json({ summary: null, status, archivedAt });
    }
});

adminSummariesRouter.post("/", async (req, res) => {
    const admin = await loadAdmin(req);
    const parsed = payloadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Validation failed", errors: z.flattenError(parsed.error).fieldErrors });

    const result = validateMeta(parsed.data.meta);
    if (!result.ok) return res.status(400).json({ message: "Validation failed", errors: result.errors });

    const record = await createSummary({ meta: result.meta, bodies: parsed.data.bodies });
    await prisma.summaryDocument.upsert({
        where: { slug: record.meta.slug },
        create: { slug: record.meta.slug, status: "PUBLISHED" },
        update: { status: "PUBLISHED", archivedAt: null, archivedBy: null },
    });
    await recordAdminAction({ admin, action: "summary.created", target: "summary", targetId: record.meta.slug, details: { title: record.meta.title } });

    const revalidation = await revalidateFrontend(pagePaths(record.meta.slug));
    res.status(201).json({ summary: record, revalidation });
});

adminSummariesRouter.put("/:slug", async (req, res) => {
    const admin = await loadAdmin(req);
    const slug = req.params.slug as string;
    const parsed = payloadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Validation failed", errors: z.flattenError(parsed.error).fieldErrors });

    const result = validateMeta(parsed.data.meta);
    if (!result.ok) return res.status(400).json({ message: "Validation failed", errors: result.errors });

    const previous = await readSummary(slug);
    const metaChanged = summarizeMeta(result.meta) !== summarizeMeta(previous.meta);
    const record = await updateSummary(slug, { meta: result.meta, bodies: parsed.data.bodies });
    await recordAdminAction({
        admin,
        action: "summary.updated",
        target: "summary",
        targetId: slug,
        details: {
            title: record.meta.title,
            metaChanged,
            bodiesChanged: Object.keys(parsed.data.bodies),
        },
    });

    const revalidation = await revalidateFrontend(pagePaths(slug));
    res.json({ summary: record, revalidation });
});

/** Cheap check before saving: returns the metadata block that would be written to summaries.ts. */
adminSummariesRouter.post("/:slug/metadata", async (req, res) => {
    const slug = req.params.slug as string;
    const result = validateMeta(req.body?.meta ?? req.body);
    if (!result.ok) return res.status(400).json({ message: "Validation failed", errors: result.errors });
    if (result.meta.slug !== slug) return res.status(400).json({ message: "Slug in the form does not match this summary" });
    res.json({ metadata: result.meta });
});

adminSummariesRouter.post("/:slug/archive", async (req, res) => {
    const admin = await loadAdmin(req);
    const slug = req.params.slug as string;
    const { status } = await statusFor(slug);
    if (status === "ARCHIVED") throw new HttpError(409, "Summary is already archived");

    await prisma.summaryDocument.upsert({
        where: { slug },
        create: { slug, status: "ARCHIVED", archivedAt: new Date(), archivedBy: admin.id },
        update: { status: "ARCHIVED", archivedAt: new Date(), archivedBy: admin.id },
    });
    await recordAdminAction({ admin, action: "summary.archived", target: "summary", targetId: slug });

    const revalidation = await revalidateFrontend(pagePaths(slug));
    res.json({ ok: true, revalidation });
});

adminSummariesRouter.post("/:slug/restore", async (req, res) => {
    const admin = await loadAdmin(req);
    const slug = req.params.slug as string;
    const { status } = await statusFor(slug);
    if (status !== "ARCHIVED") throw new HttpError(409, "Summary is not archived");

    // If summaries.ts still has the entry the summary can be flipped back to published in place.
    const metas = await listSummaryMetas();
    const stillOnDisk = metas.some((meta) => meta.slug === slug);

    await prisma.summaryDocument.upsert({
        where: { slug },
        create: { slug, status: "PUBLISHED" },
        update: { status: "PUBLISHED", archivedAt: null, archivedBy: null },
    });
    await recordAdminAction({ admin, action: "summary.restored", target: "summary", targetId: slug, details: { metadataPresent: stillOnDisk } });

    if (!stillOnDisk) {
        return res.status(409).json({
            message: "Restored the status, but the metadata is not in summaries.ts. Add the entry back to publish this summary.",
        });
    }
    const revalidation = await revalidateFrontend(pagePaths(slug));
    res.json({ ok: true, revalidation });
});

adminSummariesRouter.patch("/:slug", async (req, res) => {
    const admin = await loadAdmin(req);
    const slug = req.params.slug as string;
    const body = z.object({ status: z.enum(statusValues) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Validation failed", errors: z.flattenError(body.error).fieldErrors });

    const { status: current } = await statusFor(slug);
    if (current === body.data.status) return res.json({ ok: true });

    await prisma.summaryDocument.upsert({
        where: { slug },
        create: { slug, status: body.data.status, ...(body.data.status === "ARCHIVED" ? { archivedAt: new Date(), archivedBy: admin.id } : {}) },
        update: { status: body.data.status, ...(body.data.status === "ARCHIVED" ? { archivedAt: new Date() } : { archivedAt: null, archivedBy: null }) },
    });
    await recordAdminAction({ admin, action: `summary.status_${body.data.status.toLowerCase()}`, target: "summary", targetId: slug });
    const revalidation = await revalidateFrontend(pagePaths(slug));
    res.json({ ok: true, revalidation });
});
