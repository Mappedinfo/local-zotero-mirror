import type { ZoteroCreator, ZoteroItem } from "./types.ts";

const MAX_SEGMENT_LENGTH = 120;

export function normalizeVaultPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export function sanitizePathSegment(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  const fallback = cleaned.length > 0 ? cleaned : "Untitled";
  return fallback.slice(0, MAX_SEGMENT_LENGTH);
}

export function creatorDisplayName(creator: ZoteroCreator): string {
  if (creator.name) return creator.name;
  const parts = [creator.firstName, creator.lastName].filter(Boolean);
  return parts.join(" ").trim();
}

export function firstAuthorLastName(item: ZoteroItem): string {
  const creator = item.creators.find((entry) => entry.creatorType === "author") ?? item.creators[0];
  if (!creator) return "Unknown";
  return creator.lastName || creator.name || creatorDisplayName(creator) || "Unknown";
}

export function renderFilenameTemplate(template: string, item: ZoteroItem): string {
  const replacements: Record<string, string> = {
    year: item.year || "n.d.",
    firstAuthor: firstAuthorLastName(item),
    title: item.title || "Untitled",
    citekey: item.citekey || item.key,
    zoteroKey: item.key
  };

  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, token: string) => replacements[token] ?? "");
}

export function makePaperFileName(item: ZoteroItem, template: string): string {
  return `${sanitizePathSegment(renderFilenameTemplate(template, item))}.md`;
}

export function ensureUniquePath(path: string, usedPaths: Set<string>): string {
  const normalized = normalizeVaultPath(path);
  const key = uniquePathKey(normalized);
  if (!usedPaths.has(key)) {
    usedPaths.add(key);
    return normalized;
  }

  const dotIndex = normalized.lastIndexOf(".");
  const base = dotIndex >= 0 ? normalized.slice(0, dotIndex) : normalized;
  const extension = dotIndex >= 0 ? normalized.slice(dotIndex) : "";
  let counter = 2;
  let candidate = `${base} ${counter}${extension}`;

  while (usedPaths.has(uniquePathKey(candidate))) {
    counter += 1;
    candidate = `${base} ${counter}${extension}`;
  }

  usedPaths.add(uniquePathKey(candidate));
  return candidate;
}

export function uniquePathKey(path: string): string {
  return normalizeVaultPath(path).normalize("NFC").toLocaleLowerCase("en-US");
}

export function dirname(path: string): string {
  const normalized = normalizeVaultPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

export function stripMarkdownExtension(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

export function normalizeObsidianTag(value: string, prefix = "zotero"): string | null {
  const cleaned = value
    .normalize("NFKC")
    .replace(/^#+/, "")
    .toLocaleLowerCase("en-US")
    .replace(/['"`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^0-9a-z\u00c0-\uFFFF]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  if (!cleaned) return null;
  const tag = /^\d+$/.test(cleaned) ? `tag-${cleaned}` : cleaned;
  return prefix ? `${prefix}/${tag}` : tag;
}

export function normalizeObsidianTags(values: string[], prefix = "zotero"): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const tag = normalizeObsidianTag(value, prefix);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    output.push(tag);
  }

  return output;
}
