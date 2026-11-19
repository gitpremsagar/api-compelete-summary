import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../lib/httpError.js";
import { contentPaths } from "./content.js";
import { archivePath, assertCanCreate, mdxPath, readIfExists, readSummariesFile, readSummary, summariseBodies, type SummaryBodyInput, type SummaryRecord } from "./summaries.js";
import { insertEntry, removeEntry, replaceEntry, type SummaryMeta } from "./summary-metadata.js";

export interface SummaryPayload {
    meta: SummaryMeta;
    bodies: SummaryBodyInput;
}

async function writeAtomic(file: string, content: string) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, content, "utf8");
    await rename(temp, file);
}

/** Keeps the previous version outside the git tree so a bad edit can be recovered by hand. */
async function backup(file: string) {
    const existing = await readIfExists(file);
    if (existing === null) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(contentPaths().frontendDir, ".admin-backups", stamp, path.relative(contentPaths().frontendDir, file));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, existing, "utf8");
}

async function writeBodies(slug: string, bodies: SummaryBodyInput) {
    for (const locale of ["en", "hi"] as const) {
        const body = bodies[locale];
        if (body === undefined) continue;
        await backup(mdxPath(slug, locale));
        await writeAtomic(mdxPath(slug, locale), body.endsWith("\n") ? body : `${body}\n`);
    }
}

export async function createSummary(payload: SummaryPayload): Promise<SummaryRecord> {
    await summariseBodies(payload.bodies);
    await assertCanCreate(payload.meta.slug);

    const source = await readSummariesFile();
    await backup(contentPaths().summariesFile);
    await writeAtomic(contentPaths().summariesFile, insertEntry(source, payload.meta));
    await writeBodies(payload.meta.slug, { en: payload.bodies.en ?? "", ...(payload.bodies.hi !== undefined ? { hi: payload.bodies.hi } : {}) });
    return readSummary(payload.meta.slug);
}

export async function updateSummary(slug: string, payload: SummaryPayload): Promise<SummaryRecord> {
    if (payload.meta.slug !== slug) {
        throw new HttpError(400, "The slug of an existing summary cannot be changed");
    }
    await summariseBodies(payload.bodies);

    const source = await readSummariesFile();
    await backup(contentPaths().summariesFile);
    await writeAtomic(contentPaths().summariesFile, replaceEntry(source, slug, payload.meta));
    await writeBodies(slug, payload.bodies);
    return readSummary(slug);
}

/** Moves the MDX bodies into content/archive/ and removes the metadata entry from summaries.ts. */
export async function archiveSummaryFiles(slug: string): Promise<void> {
    const source = await readSummariesFile();
    await backup(contentPaths().summariesFile);
    await writeAtomic(contentPaths().summariesFile, removeEntry(source, slug));

    for (const locale of ["en", "hi"]) {
        const from = mdxPath(slug, locale);
        const content = await readIfExists(from);
        if (content === null) continue;
        const to = archivePath(slug, locale);
        await mkdir(path.dirname(to), { recursive: true });
        await writeAtomic(to, content);
        await rename(from, `${from}.archived-${Date.now()}`);
    }
}

/** Restores MDX bodies from content/archive/ and appends the metadata entry to summaries.ts. */
export async function restoreSummaryFiles(meta: SummaryMeta): Promise<SummaryRecord> {
    const source = await readSummariesFile();
    const bodies: SummaryBodyInput = {};
    for (const locale of ["en", "hi"] as const) {
        const content = await readIfExists(archivePath(meta.slug, locale));
        if (content !== null) bodies[locale] = content;
    }
    if (bodies.en === undefined) {
        throw new HttpError(409, "The English MDX file is no longer in content/archive/, so this summary cannot be restored");
    }

    await backup(contentPaths().summariesFile);
    await writeAtomic(contentPaths().summariesFile, insertEntry(source, meta));
    await writeBodies(meta.slug, bodies);
    return readSummary(meta.slug);
}
