import type { SummaryRecord } from "./summaries.js";

export function toSummaryRow(record: SummaryRecord) {
    return {
        slug: record.meta.slug,
        kind: record.meta.kind,
        title: record.meta.title,
        description: record.meta.description,
        publishedAt: record.meta.publishedAt,
        updatedAt: record.meta.updatedAt ?? null,
        tags: record.meta.tags,
        hasHindi: Boolean(record.meta.hi),
        wordCount: record.wordCount,
        status: record.status,
        archivedAt: record.archivedAt,
        hasBody: record.bodies.en !== null,
        hasHindiBody: record.bodies.hi !== null,
    };
}
