import { HttpError } from "../lib/httpError.js";

export type SummaryKind = "Podcast" | "Audiobook" | "Video";

export interface SummaryStat {
    value: string;
    label: string;
}

export interface SummaryTranslation {
    title: string;
    description: string;
    intro: string;
    tags: string[];
    stats: SummaryStat[];
    guestBio?: string;
    searchExamples?: string[];
}

export interface SummaryMeta {
    slug: string;
    kind: SummaryKind;
    title: string;
    description: string;
    intro: string;
    guest?: string;
    guestBio?: string;
    host?: string;
    show?: string;
    episode?: string;
    sourceUrl?: string;
    youtubeId?: string;
    publishedAt: string;
    updatedAt?: string;
    tags: string[];
    stats: SummaryStat[];
    searchExamples?: string[];
    hi?: SummaryTranslation;
}

type ParsedMeta = SummaryMeta;

interface Entry {
    start: number;
    end: number;
    slug: string;
}

interface CursorScan {
    inString: '"' | "'" | "`" | null;
    escaped: boolean;
    inLineComment: boolean;
    inBlockComment: boolean;
}

/**
 * Walks `source` from `start`, skipping strings and comments, so callers only see real code characters.
 */
function scan(source: string, start: number, onChar: (index: number, depth: number) => number | void) {
    const state: CursorScan = { inString: null, escaped: false, inLineComment: false, inBlockComment: false };
    let depth = 0;

    for (let i = start; i < source.length; i++) {
        const ch = source[i]!;
        const next = source[i + 1];

        if (state.inLineComment) {
            if (ch === "\n") state.inLineComment = false;
            continue;
        }
        if (state.inBlockComment) {
            if (ch === "*" && next === "/") {
                state.inBlockComment = false;
                i++;
            }
            continue;
        }
        if (state.inString) {
            if (state.escaped) {
                state.escaped = false;
            } else if (ch === "\\") {
                state.escaped = true;
            } else if (ch === state.inString) {
                state.inString = null;
            }
            continue;
        }
        if (ch === "/" && next === "/") {
            state.inLineComment = true;
            i++;
            continue;
        }
        if (ch === "/" && next === "*") {
            state.inBlockComment = true;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            state.inString = ch;
            continue;
        }

        // `depth` is the nesting level of this character: 0 at top level, 1 inside the first bracket.
        const action = onChar(i, depth);
        if (action !== undefined) return action;

        const opens = ch === "[" || ch === "{" || ch === "(";
        const closes = ch === "]" || ch === "}" || ch === ")";
        if (opens) depth++;
        if (closes) depth--;
    }
    return undefined;
}

function arrayLiteralBounds(source: string): { arrayStart: number; arrayEnd: number } {
    const marker = source.indexOf("export const summaries: SummaryMeta[] =");
    if (marker === -1) {
        throw new HttpError(500, "Could not find the summaries array in summaries.ts");
    }
    const equalsIndex = source.indexOf("=", marker + "export const summaries: SummaryMeta".length);
    const arrayStart = source.indexOf("[", equalsIndex + 1);
    if (equalsIndex === -1 || arrayStart === -1) {
        throw new HttpError(500, "Could not find the summaries array in summaries.ts");
    }

    const arrayEnd = scan(source, arrayStart + 1, (i, depth) => {
        if (source[i] === "]" && depth === 0) return i;
    });
    if (arrayEnd === undefined) throw new HttpError(500, "Could not find the end of the summaries array in summaries.ts");
    return { arrayStart, arrayEnd };
}

// Literal text with string contents (so JSON.parse can read it) and offsets of every non-string character.
interface MaskedSource {
    json: string;
    /** json index -> original index, for characters copied outside of string literals. */
    originOf: number[];
    /** Original index of every copied character. */
    origin: number[];
}

function toJson(literalSource: string, offset: number): MaskedSource {
    let json = "";
    let inString: '"' | "'" | "`" | null = null;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;
    const origin: number[] = [];

    const push = (text: string, originalIndex: number) => {
        for (let j = 0; j < text.length; j++) origin.push(originalIndex);
        json += text;
    };

    for (let i = 0; i < literalSource.length; i++) {
        const ch = literalSource[i]!;
        const next = literalSource[i + 1];
        const sourceIndex = offset + i;

        if (inLineComment) {
            if (ch === "\n") {
                inLineComment = false;
                push("\n", sourceIndex);
            } else push(" ", sourceIndex);
            continue;
        }
        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                inBlockComment = false;
                i++;
            }
            push(" ", sourceIndex);
            continue;
        }
        if (inString) {
            if (escaped) {
                push(ch, sourceIndex);
                escaped = false;
            } else if (ch === "\\") {
                push(ch, sourceIndex);
                escaped = true;
            } else if (ch === inString) {
                push('"', sourceIndex);
                inString = null;
            } else if (ch === '"') {
                push('\\"', sourceIndex);
            } else {
                push(ch, sourceIndex);
            }
            continue;
        }
        if (ch === "/" && next === "/") {
            inLineComment = true;
            push(" ", sourceIndex);
            i++;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlockComment = true;
            push(" ", sourceIndex);
            i++;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            push('"', sourceIndex);
            inString = ch;
            continue;
        }
        push(ch, sourceIndex);
    }

    if (inString) throw new HttpError(400, "The metadata contains an unterminated string");

    // Quote bare keys (`slug:` -> `"slug":`) outside of strings.
    let result = "";
    const origins: number[] = [];
    let j = 0;
    while (j < json.length) {
        const rest = json.slice(j);
        const match = /^([A-Za-z_$][\w$]*)(\s*:)/.exec(rest);
        const insideString = isInsideString(json, j);
        if (match && !insideString) {
            const quoted = `${JSON.stringify(match[1])}${match[2]}`;
            for (let k = 0; k < quoted.length; k++) origins.push(origin[j] ?? 0);
            result += quoted;
            j += match[0].length;
        } else {
            origins.push(origin[j] ?? 0);
            result += json[j];
            j++;
        }
    }

    return { json: result.replace(/,(?=\s*[\]}])/g, " "), originOf: origins, origin };
}

function isInsideString(text: string, index: number) {
    let inside = false;
    for (let i = 0; i < index; i++) {
        if (text[i] === "\\") {
            i++;
            continue;
        }
        if (text[i] === '"') inside = !inside;
    }
    return inside;
}

export interface ParsedSummaries {
    source: string;
    bounds: { arrayStart: number; arrayEnd: number };
    entries: Entry[];
}

export function parseSummaryEntries(source: string): ParsedSummaries {
    const bounds = arrayLiteralBounds(source);
    const entries: Entry[] = [];
    let objectStart = -1;

    scan(source, bounds.arrayStart + 1, (i, depth) => {
        const ch = source[i]!;
        if (ch === "{") {
            if (depth === 0) {
                objectStart = i;
                return;
            }
        }
        if (ch === "}") {
            if (depth === 1 && objectStart !== -1) {                const end = i + 1;
                if (end > bounds.arrayEnd) return;
                const literal = source.slice(objectStart, end);
                const slug = /^\{\s*slug:\s*"([^"]+)"/.exec(literal)?.[1];
                if (slug) entries.push({ start: objectStart, end, slug });
                objectStart = -1;
            }
        }
    });

    return { source, bounds, entries };
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

export function assertSlug(value: string): string {
    if (!SLUG_PATTERN.test(value)) {
        throw new HttpError(400, "Slug must be lowercase letters, numbers and dashes");
    }
    return value;
}

export function parseSummaries(source: string): { summary: ParsedSummaries; metas: ParsedMeta[] } {
    const summary = parseSummaryEntries(source);
    const metas = summary.entries.map(({ start, end }) => {
        const { json } = toJson(source.slice(start, end), start);
        const meta = JSON.parse(json) as ParsedMeta;
        if (!meta.slug) throw new HttpError(500, "A summary entry is missing its slug");
        return meta;
    });
    return { summary, metas };
}

function key(name: string) {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown, indent: number): string {
    const pad = "  ".repeat(indent);
    const inner = "  ".repeat(indent + 1);
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        const simple = value.every((item) => typeof item === "string");
        if (simple) {
            const oneLine = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
            if (oneLine.length + pad.length <= 110) return oneLine;
        }
        return `[\n${value.map((item) => `${inner}${literal(item, indent + 1)},`).join("\n")}\n${pad}]`;
    }
    const rows = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    if (rows.length === 0) return "{}";
    if (rows.length === 1 && typeof rows[0]![1] === "string" && (rows[0]![1] as string).length < 80) {
        const [k, item] = rows[0]!;
        return `{ ${key(k)}: ${JSON.stringify(item)} }`;
    }
    return `{\n${rows.map(([k, item]) => `${inner}${key(k)}: ${literal(item, indent + 1)},`).join("\n")}\n${pad}}`;
}

export function serializeMeta(meta: ParsedMeta, indent: number): string {
    const ordered: Record<string, unknown> = {
        slug: meta.slug,
        kind: meta.kind,
        title: meta.title,
        description: meta.description,
        intro: meta.intro,
    };
    const optional = ["guest", "guestBio", "host", "show", "episode", "sourceUrl", "youtubeId"] as const;
    for (const field of optional) {
        if (meta[field] !== undefined) ordered[field] = meta[field];
    }
    ordered.publishedAt = meta.publishedAt;
    if (meta.updatedAt !== undefined) ordered.updatedAt = meta.updatedAt;
    ordered.tags = meta.tags;
    ordered.stats = meta.stats;
    if (meta.searchExamples !== undefined) ordered.searchExamples = meta.searchExamples;
    if (meta.hi !== undefined) ordered.hi = meta.hi;
    return literal(ordered, indent);
}

export function replaceEntry(source: string, slug: string, meta: ParsedMeta): string {
    const { entries } = parseSummaryEntries(source);
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) throw new HttpError(404, "Summary not found in summaries.ts");

    const lineStart = source.lastIndexOf("\n", entry.start) + 1;
    const leading = source.slice(lineStart, entry.start);
    const indent = /^[ \t]*$/.test(leading) ? Math.floor(leading.length / 2) : 1;
    return source.slice(0, entry.start) + serializeMeta(meta, indent) + source.slice(entry.end);
}

export function insertEntry(source: string, meta: ParsedMeta): string {
    const { arrayEnd } = arrayLiteralBounds(source);
    const before = source.slice(0, arrayEnd).replace(/\s+$/, "");
    const after = source.slice(arrayEnd);
    return `${before}\n  ${serializeMeta(meta, 1)},\n${after}`;
}

export function removeEntry(source: string, slug: string): string {
    const { entries } = parseSummaryEntries(source);
    const entry = entries.find((e) => e.slug === slug);
    if (!entry) throw new HttpError(404, "Summary not found in summaries.ts");

    let start = entry.start;
    let end = entry.end;
    // Swallow the trailing comma, following newline and indentation of the next entry.
    let cursor = end;
    while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) cursor++;
    if (source[cursor] === ",") {
        cursor++;
        if (source[cursor] === "\n") cursor++;
        while (source[cursor] === " " || source[cursor] === "\t") cursor++;
        end = cursor;
    }
    // Swallow the indentation and a blank line before the entry.
    while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
    return source.slice(0, start) + source.slice(end);
}
