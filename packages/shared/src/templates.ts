import { creatorDisplayName, normalizeObsidianTags, stripMarkdownExtension } from "./format.ts";
import { mergeManagedFrontmatter, type YamlValue } from "./frontmatter.ts";
import type { ZoteroCollection, ZoteroItem, ZoteroNativeNote } from "./types.ts";

export const MANAGED_BLOCK_START = "<!-- BEGIN OBSIDIAN-ZOTERO-METADATA -->";
export const MANAGED_BLOCK_END = "<!-- END OBSIDIAN-ZOTERO-METADATA -->";
export const NATIVE_NOTES_HEADING = "# zotero原生笔记迁移";
export const NATIVE_NOTES_BLOCK_START = "<!-- BEGIN OBSIDIAN-ZOTERO-NATIVE-NOTES -->";
export const NATIVE_NOTES_BLOCK_END = "<!-- END OBSIDIAN-ZOTERO-NATIVE-NOTES -->";
export const USER_NOTES_BLOCK_START = "<!-- BEGIN OBSIDIAN-ZOTERO-USER-NOTES -->";
export const USER_NOTES_BLOCK_END = "<!-- END OBSIDIAN-ZOTERO-USER-NOTES -->";

export function buildManagedFields(
  item: ZoteroItem,
  now: string,
  collectionLabels: string[],
  deleted = false,
  nativeNoteCount?: number
): Record<string, YamlValue> {
  const pdfUri = item.pdfUri || item.attachments.find((attachment) => attachment.zoteroUri)?.zoteroUri;

  const fields: Record<string, YamlValue> = {
    zotero_key: item.key,
    citekey: item.citekey,
    citation_aliases: item.citation?.aliases,
    citekey_source: item.citation?.citekeySource,
    citation_apa: item.citation?.apaInText,
    reference_apa: item.citation?.apaReference,
    bibtex: item.citation?.bibtex,
    title: item.title,
    authors: item.creators.map(creatorDisplayName).filter(Boolean),
    year: item.year,
    item_type: item.itemType,
    publication: item.publicationTitle,
    doi: item.doi,
    url: item.url,
    collections: collectionLabels,
    tags: normalizeObsidianTags(item.tags),
    zotero_tags: item.tags,
    zotero_uri: item.zoteroUri,
    pdf_uri: pdfUri,
    zotero_version: item.version,
    last_synced: now,
    zotero_deleted: deleted
  };

  if (nativeNoteCount !== undefined) {
    fields.zotero_native_note_count = nativeNoteCount;
    fields.zotero_native_notes_last_synced = now;
  }

  return fields;
}

export function renderMetadataBlock(item: ZoteroItem, collectionLabels: string[], deleted = false): string {
  const lines = [
    MANAGED_BLOCK_START,
    "> [!info] Zotero",
    `> Title: ${item.title || "Untitled"}`,
    `> Key: ${item.key}`,
    item.citekey ? `> Citekey: ${item.citekey}` : undefined,
    item.citation?.apaInText ? `> Citation: ${item.citation.apaInText}` : undefined,
    item.year ? `> Year: ${item.year}` : undefined,
    item.publicationTitle ? `> Publication: ${item.publicationTitle}` : undefined,
    item.doi ? `> DOI: ${item.doi}` : undefined,
    item.zoteroUri ? `> Zotero: ${item.zoteroUri}` : undefined,
    collectionLabels.length > 0 ? `> Collections: ${collectionLabels.join(" / ")}` : undefined,
    deleted ? "> Status: missing from latest Zotero snapshot" : undefined,
    MANAGED_BLOCK_END
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}

export function paperNoteTemplate(): string {
  return [
    "## Summary",
    "",
    "",
    "## Research Question",
    "",
    "",
    "## Method",
    "",
    "",
    "## Evidence",
    "",
    "",
    "## Useful Ideas",
    "",
    "",
    "## Critique",
    "",
    "",
    "## Follow-up",
    ""
  ].join("\n");
}

export function renderNewPaperNote(item: ZoteroItem, now: string, collectionLabels: string[]): string {
  const shell = `${renderMetadataBlock(item, collectionLabels)}\n\n${renderUserNotesBlock(paperNoteTemplate())}`;
  return mergeManagedFrontmatter(shell, buildManagedFields(item, now, collectionLabels));
}

export function renderNewPaperNoteWithNativeNotes(
  item: ZoteroItem,
  now: string,
  collectionLabels: string[],
  nativeNotes: ZoteroNativeNote[]
): string {
  const base = renderNewPaperNote(item, now, collectionLabels);
  const withFrontmatter = mergeManagedFrontmatter(
    base,
    buildManagedFields(item, now, collectionLabels, false, nativeNotes.length)
  );
  return upsertNativeNotesBlock(withFrontmatter, nativeNotes, now);
}

export function mergeExistingPaperNote(
  existing: string,
  item: ZoteroItem,
  now: string,
  collectionLabels: string[],
  deleted = false,
  nativeNotes: ZoteroNativeNote[] = []
): string {
  const shouldManageNativeNotes = nativeNotes.length > 0 || hasNativeNotesBlock(existing);
  const withFrontmatter = mergeManagedFrontmatter(
    existing,
    buildManagedFields(item, now, collectionLabels, deleted, shouldManageNativeNotes ? nativeNotes.length : undefined)
  );
  const withMetadata = upsertManagedBlock(withFrontmatter, renderMetadataBlock(item, collectionLabels, deleted));
  const withNativeNotes = shouldManageNativeNotes ? upsertNativeNotesBlock(withMetadata, nativeNotes, now) : withMetadata;
  return deleted ? withNativeNotes : ensureUserNotesBlock(withNativeNotes);
}

export function upsertManagedBlock(markdown: string, block: string): string {
  const startIndex = markdown.indexOf(MANAGED_BLOCK_START);
  const endIndex = markdown.indexOf(MANAGED_BLOCK_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = markdown.slice(0, startIndex).replace(/\n*$/, "\n\n");
    const after = markdown.slice(endIndex + MANAGED_BLOCK_END.length).replace(/^\n*/, "\n\n");
    return `${before}${block}${after}`.replace(/\n+$/, "\n");
  }

  const frontmatterEnd = markdown.startsWith("---\n") ? markdown.indexOf("\n---", 4) : -1;
  if (frontmatterEnd !== -1) {
    const insertionPoint = frontmatterEnd + "\n---".length;
    const before = markdown.slice(0, insertionPoint).replace(/\n*$/, "\n\n");
    const after = markdown.slice(insertionPoint).replace(/^\n*/, "\n\n");
    return `${before}${block}${after}`.replace(/\n+$/, "\n");
  }

  return `${block}\n\n${markdown.replace(/^\n*/, "")}`.replace(/\n+$/, "\n");
}

export function renderUserNotesBlock(markdown: string): string {
  return [USER_NOTES_BLOCK_START, normalizeUserNotesMarkdown(markdown) || paperNoteTemplate().trim(), USER_NOTES_BLOCK_END]
    .join("\n")
    .replace(/\n+$/, "\n");
}

export function hasUserNotesBlock(markdown: string): boolean {
  return markdown.includes(USER_NOTES_BLOCK_START) && markdown.includes(USER_NOTES_BLOCK_END);
}

export function extractUserNotesMarkdown(markdown: string): string | null {
  const startIndex = markdown.indexOf(USER_NOTES_BLOCK_START);
  const endIndex = markdown.indexOf(USER_NOTES_BLOCK_END);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return null;
  return markdown.slice(startIndex + USER_NOTES_BLOCK_START.length, endIndex).replace(/^\n/, "").replace(/\n$/, "");
}

export function ensureUserNotesBlock(markdown: string): string {
  if (hasUserNotesBlock(markdown)) return markdown;
  const insertionPoint = findUserNotesInsertionPoint(markdown);
  const before = markdown.slice(0, insertionPoint).replace(/\n*$/, "\n\n");
  const userMarkdown = markdown.slice(insertionPoint).trim();
  return `${before}${renderUserNotesBlock(userMarkdown)}\n`.replace(/\n+$/, "\n");
}

export function hashObsidianUserNotes(markdown: string): string {
  const text = canonicalUserNotesMarkdown(markdown);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

function canonicalUserNotesMarkdown(markdown: string): string {
  return normalizeUserNotesMarkdown(markdown)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeUserNotesMarkdown(markdown: string): string {
  return String(markdown || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function findUserNotesInsertionPoint(markdown: string): number {
  const normalized = markdown.replace(/\r\n/g, "\n");
  let cursor = 0;
  if (normalized.startsWith("---\n")) {
    const frontmatterEnd = normalized.indexOf("\n---", 4);
    if (frontmatterEnd !== -1) cursor = frontmatterEnd + "\n---".length;
  }

  const metadataEnd = normalized.indexOf(MANAGED_BLOCK_END);
  if (metadataEnd !== -1) cursor = Math.max(cursor, metadataEnd + MANAGED_BLOCK_END.length);

  const nativeEnd = normalized.indexOf(NATIVE_NOTES_BLOCK_END);
  if (nativeEnd !== -1) cursor = Math.max(cursor, nativeEnd + NATIVE_NOTES_BLOCK_END.length);

  while (cursor < normalized.length && /\s/.test(normalized[cursor] || "")) cursor += 1;
  return cursor;
}

export function hasNativeNotesBlock(markdown: string): boolean {
  return markdown.includes(NATIVE_NOTES_BLOCK_START) && markdown.includes(NATIVE_NOTES_BLOCK_END);
}

export function upsertNativeNotesBlock(markdown: string, nativeNotes: ZoteroNativeNote[], now: string): string {
  const block = renderNativeNotesBlock(nativeNotes, now);
  const startIndex = markdown.indexOf(NATIVE_NOTES_BLOCK_START);
  const endIndex = markdown.indexOf(NATIVE_NOTES_BLOCK_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const headingStart = findNativeNotesHeadingStart(markdown, startIndex);
    const replaceStart = headingStart === -1 ? startIndex : headingStart;
    const before = markdown.slice(0, replaceStart).replace(/\n*$/, "\n\n");
    const after = markdown.slice(endIndex + NATIVE_NOTES_BLOCK_END.length).replace(/^\n*/, "\n\n");
    return `${before}${block}${after}`.replace(/\n+$/, "\n");
  }

  const metadataEnd = markdown.indexOf(MANAGED_BLOCK_END);
  if (metadataEnd !== -1) {
    const insertionPoint = metadataEnd + MANAGED_BLOCK_END.length;
    const before = markdown.slice(0, insertionPoint).replace(/\n*$/, "\n");
    const after = markdown.slice(insertionPoint).replace(/^\n*/, "\n\n");
    return `${before}\n\n${block}${after}`.replace(/\n+$/, "\n");
  }

  const frontmatterEnd = markdown.startsWith("---\n") ? markdown.indexOf("\n---", 4) : -1;
  if (frontmatterEnd !== -1) {
    const insertionPoint = frontmatterEnd + "\n---".length;
    const before = markdown.slice(0, insertionPoint).replace(/\n*$/, "\n");
    const after = markdown.slice(insertionPoint).replace(/^\n*/, "\n\n");
    return `${before}\n\n${block}${after}`.replace(/\n+$/, "\n");
  }

  return `${block}\n\n${markdown.replace(/^\n*/, "")}`.replace(/\n+$/, "\n");
}

export function renderNativeNotesBlock(nativeNotes: ZoteroNativeNote[], now: string): string {
  const sorted = [...nativeNotes].sort(
    (a, b) =>
      (a.dateModified || "").localeCompare(b.dateModified || "") ||
      (a.title || "").localeCompare(b.title || "") ||
      a.key.localeCompare(b.key)
  );
  const body =
    sorted.length === 0
      ? "_Latest Zotero snapshot has no native notes linked to this item._"
      : sorted.map((note) => renderNativeNoteEntry(note)).join("\n\n---\n\n");

  return [
    NATIVE_NOTES_HEADING,
    NATIVE_NOTES_BLOCK_START,
    `Synced: ${now}`,
    "",
    body,
    NATIVE_NOTES_BLOCK_END
  ].join("\n");
}

export function renderNativeNoteEntry(note: ZoteroNativeNote): string {
  const title = note.title || `Zotero note ${note.key}`;
  const lines = [
    `## ${escapeMarkdownHeading(title)}`,
    "",
    `> Zotero note key: ${note.key}`,
    note.dateModified ? `> Updated: ${note.dateModified}` : undefined,
    note.zoteroUri ? `> Zotero: ${note.zoteroUri}` : undefined,
    "",
    htmlToMarkdown(note.noteHtml).trim() || "_Empty Zotero note._"
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

export function renderNewStandaloneNativeNote(note: ZoteroNativeNote, now: string): string {
  const title = note.title || `Zotero note ${note.key}`;
  const shell = [
    `# ${escapeMarkdownHeading(title)}`,
    "",
    renderNativeNotesBlock([note], now),
    "",
    "## Obsidian notes",
    ""
  ].join("\n");
  return mergeManagedFrontmatter(shell, buildStandaloneNativeNoteFields(note, now, false));
}

export function mergeExistingStandaloneNativeNote(
  existing: string,
  note: ZoteroNativeNote,
  now: string,
  deleted = false
): string {
  const withFrontmatter = mergeManagedFrontmatter(existing, buildStandaloneNativeNoteFields(note, now, deleted));
  return deleted ? withFrontmatter : upsertNativeNotesBlock(withFrontmatter, [note], now);
}

export function buildStandaloneNativeNoteFields(
  note: ZoteroNativeNote,
  now: string,
  deleted = false
): Record<string, YamlValue> {
  return {
    zotero_note_key: note.key,
    zotero_parent_key: note.parentItemKey ?? null,
    zotero_uri: note.zoteroUri,
    title: note.title || `Zotero note ${note.key}`,
    last_synced: now,
    zotero_note_deleted: deleted
  };
}

export function renderCollectionIndex(
  collection: ZoteroCollection,
  items: ZoteroItem[],
  notePathsByItemKey: Map<string, string>,
  now: string
): string {
  const frontmatter = [
    "---",
    `zotero_collection_key: ${JSON.stringify(collection.key)}`,
    `title: ${JSON.stringify(collection.name)}`,
    `last_synced: ${JSON.stringify(now)}`,
    "obsidian_zotero_generated: true",
    "---"
  ].join("\n");
  const linkedItems = items
    .filter((item) => notePathsByItemKey.has(item.key))
    .sort((a, b) => (a.year || "").localeCompare(b.year || "") || a.title.localeCompare(b.title))
    .map((item) => `- ${formatNoteLink(notePathsByItemKey.get(item.key)!, item.title)}`);

  return [
    frontmatter,
    "",
    `# ${collection.name}`,
    "",
    collection.path.length > 1 ? `Path: ${collection.path.join(" / ")}` : "",
    "",
    linkedItems.length > 0 ? linkedItems.join("\n") : "_No Zotero items in this collection yet._",
    ""
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

function formatNoteLink(path: string, title: string): string {
  const linkPath = stripMarkdownExtension(path).replace(/\|/g, "\\|");
  const alias = (title || "Untitled").replace(/\|/g, "\\|").replace(/\]/g, "\\]");
  return `[[${linkPath}|${alias}]]`;
}

export function htmlToMarkdown(html: string): string {
  let markdown = html
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|blockquote|h[1-6])>/gi, "\n\n")
    .replace(/<(p|div|section|article)[^>]*>/gi, "")
    .replace(/<h([1-6])[^>]*>/gi, (_, level: string) => `${"#".repeat(Number(level))} `)
    .replace(/<blockquote[^>]*>/gi, "> ")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_")
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "_$1_")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
      const label = stripTags(text).trim() || href;
      return `[${label}](${href})`;
    })
    .replace(/<[^>]+>/g, "");

  markdown = decodeHtmlEntities(markdown)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return markdown ? `${markdown}\n` : "";
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return named[lower] ?? `&${entity};`;
  });
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

function findNativeNotesHeadingStart(markdown: string, blockStartIndex: number): number {
  const before = markdown.slice(0, blockStartIndex);
  const lastHeadingIndex = before.lastIndexOf(NATIVE_NOTES_HEADING);
  if (lastHeadingIndex === -1) return -1;
  const between = before.slice(lastHeadingIndex + NATIVE_NOTES_HEADING.length);
  return between.trim().length === 0 ? lastHeadingIndex : -1;
}
