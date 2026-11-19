import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../lib/httpError.js";
import { prisma } from "../lib/prisma.js";
import { contentPaths } from "./content.js";
import { parseSummaries, type SummaryMeta } from "./summary-metadata.js";

export const MAX_BODY_BYTES = 512 * 1024;

export interface SummaryBodyInput {
    en?: string | undefined;
    hi?: string | undefined;
}

export interface SummaryRecord {
    meta: SummaryMeta;
    status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
    archivedAt: string | null;
    bodies: { en: string | null; hi: string | null };
    wordCount: number;
}

export function mdxPath(slug: string, locale: string) {
    const { summariesDir } = contentPaths();
    return locale === "hi" ? path.join(summariesDir, "hi", `${slug}.mdx`) : path.join(summariesDir, `${slug}.mdx`);
}

export function archivePath(slug: string, locale: string) {
    const archiveDir = path.join(contentPaths().summariesDir, "..", "archive");
    return path.join(archiveDir, locale === "hi" ? `${slug}.hi.mdx` : `${slug}.mdx`);
}

export async function readIfExists(file: string): Promise<string | null> {
    try {
        return await readFile(file, "utf8");
    } catch {
        return null;
    }
}

export async function readSummariesFile(): Promise<string> {
    try {
        return await readFile(contentPaths().summariesFile, "utf8");
    } catch {
        throw new HttpError(500, "Could not read summaries.ts. Check FRONTEND_DIR on the API server.");
    }
}

export async function listSummaryMetas(): Promise<SummaryMeta[]> {
    const { metas } = parseSummaries(await readSummariesFile());
    return metas;
}

export function countWords(text: string | null): number {
    if (!text) return 0;
    const plain = text
        .replace(/^import .*$/gm, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z]+;/g, " ");
    return plain.split(/\s+/).filter(Boolean).length;
}

export async function readSummary(slug: string): Promise<SummaryRecord> {
    const metas = await listSummaryMetas();
    const meta = metas.find((m) => m.slug === slug);
    if (!meta) throw new HttpError(404, "Summary not found");

    const [en, hi] = await Promise.all([readIfExists(mdxPath(slug, "en")), readIfExists(mdxPath(slug, "hi"))]);

    const status = (await prisma.summaryDocument.findUnique({ where: { slug }, select: { status: true, archivedAt: true } })) ?? {
        status: "PUBLISHED" as const,
        archivedAt: null,
    };
    return {
        meta,
        status: status.status,
        archivedAt: status.archivedAt ? status.archivedAt.toISOString() : null,
        bodies: { en, hi },
        wordCount: countWords(en),
    };
}

async function assertCanCreate(slug: string) {
    const metas = await listSummaryMetas();
    if (metas.some((m) => m.slug === slug)) {
        throw new HttpError(409, "A summary with this slug already exists");
    }
    for (const locale of ["en", "hi"]) {
        if ((await readIfExists(mdxPath(slug, locale))) !== null) {
            throw new HttpError(409, `content/summaries/${locale === "hi" ? "hi/" : ""}${slug}.mdx already exists`);
        }
    }
}

export async function summariseBodies(bodies: SummaryBodyInput): Promise<SummaryBodyInput> {
    for (const locale of ["en", "hi"] as const) {
        const body = bodies[locale];
        if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
            throw new HttpError(413, `The ${locale.toUpperCase()} body is larger than ${Math.round(MAX_BODY_BYTES / 1024)} KB`);
        }
    }
    return bodies;
}

export { assertCanCreate };

/** Compares summaries.ts with the MDX files on disk so editors can spot problems up front. */
export async function contentHealth() {
    const metas = await listSummaryMetas();
    const missingBodies: { slug: string; locale: string }[] = [];
    for (const meta of metas) {
        for (const locale of ["en", "hi"]) {
            if ((await readIfExists(mdxPath(meta.slug, locale))) === null) {
                missingBodies.push({ slug: meta.slug, locale });
            }
        }
    }
    return { missingBodies };
}
