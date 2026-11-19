import { z } from "zod";
import type { SummaryKind, SummaryMeta, SummaryStat, SummaryTranslation } from "./summary-metadata.js";

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/, "Slug must be lowercase letters, numbers and dashes");
const statSchema = z.object({ value: z.string().trim().min(1).max(120), label: z.string().trim().min(1).max(400) });

const translationSchema = z
    .object({
        title: z.string().trim().min(1).max(300),
        description: z.string().trim().min(1).max(2000),
        intro: z.string().trim().min(1).max(4000),
        tags: z.array(z.string().trim().min(1).max(80)).max(40),
        stats: z.array(statSchema).max(12),
        guestBio: z.string().trim().max(500).optional(),
        searchExamples: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
    })
    .strict();

export const metaSchema = z
    .object({
        slug: slugSchema,
        kind: z.enum(["Podcast", "Audiobook", "Video"]),
        title: z.string().trim().min(1).max(300),
        description: z.string().trim().min(1).max(2000),
        intro: z.string().trim().min(1).max(4000),
        guest: z.string().trim().max(160).optional(),
        guestBio: z.string().trim().max(500).optional(),
        host: z.string().trim().max(160).optional(),
        show: z.string().trim().max(160).optional(),
        episode: z.string().trim().max(80).optional(),
        sourceUrl: z.string().url().max(500).optional(),
        youtubeId: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9_-]{6,20}$/, "Use just the YouTube video ID")
            .optional(),
        publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
        updatedAt: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
            .optional(),
        tags: z.array(z.string().trim().min(1).max(80)).min(1, "Add at least one tag").max(40),
        stats: z.array(statSchema).min(1, "Add at least one stat").max(12),
        searchExamples: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
        hi: translationSchema.optional(),
    })
    .strict();

export type ValidationResult = { ok: true; meta: SummaryMeta } | { ok: false; errors: Record<string, string[]> };

function flattenErrors(issues: z.ZodIssue[]) {
    const errors: Record<string, string[]> = {};
    for (const issue of issues) {
        const path = issue.path.join(".") || "_";
        (errors[path] ??= []).push(issue.message);
    }
    return errors;
}

export function validateMeta(input: unknown): ValidationResult {
    const parsed = metaSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errors: flattenErrors(parsed.error.issues) };
    return { ok: true, meta: parsed.data as SummaryMeta };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a stable JSON string for change detection. */
export function summarizeMeta(meta: SummaryMeta) {
    return JSON.stringify(meta);
}

export type { SummaryKind, SummaryStat, SummaryTranslation };
