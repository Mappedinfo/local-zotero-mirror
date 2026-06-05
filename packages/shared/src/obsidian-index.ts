import { normalizeVaultPath } from "./format.ts";
import { readFrontmatterString, readFrontmatterStringArray } from "./frontmatter.ts";
import type {
  NoteRecord,
  SyncSettings,
  ZoteroCitationMetadata,
  ZoteroObsidianIndex
} from "./types.ts";

export function buildObsidianIndexFromNotes(
  records: NoteRecord[],
  settings: SyncSettings,
  now: string
): ZoteroObsidianIndex | null {
  const papersRoot = normalizeVaultPath(`${settings.targetFolder}/${settings.papersFolderName}`);
  const standaloneRoot = normalizeVaultPath(`${settings.targetFolder}/${settings.standaloneNotesFolderName}`);
  const index: ZoteroObsidianIndex = {
    schemaVersion: 1,
    generatedAt: now,
    targetFolder: settings.targetFolder,
    papersFolderName: settings.papersFolderName,
    standaloneNotesFolderName: settings.standaloneNotesFolderName,
    items: {},
    standaloneNotes: {}
  };

  for (const record of records) {
    const path = normalizeVaultPath(record.path);
    if (path.startsWith(`${papersRoot}/`)) {
      addPaperIndexItem(index, path, record.content, now);
      continue;
    }
    if (path.startsWith(`${standaloneRoot}/`)) {
      addStandaloneNoteIndexItem(index, path, record.content, now);
    }
  }

  return Object.keys(index.items).length > 0 || Object.keys(index.standaloneNotes).length > 0 ? index : null;
}

function addPaperIndexItem(index: ZoteroObsidianIndex, path: string, markdown: string, now: string): void {
  const itemKey = readFrontmatterString(markdown, "zotero_key");
  const citekey = readFrontmatterString(markdown, "citekey");
  if (!itemKey && !citekey) return;

  const key = itemKey || citekey!;
  const title = readFrontmatterString(markdown, "title") || titleFromPath(path);
  const nativeNoteCount = Number(readFrontmatterString(markdown, "zotero_native_note_count") ?? 0);
  index.items[key] = {
    itemKey: key,
    path,
    title,
    citekey,
    citation: citekey ? citationFromFrontmatter(markdown, citekey) : undefined,
    zoteroUri: readFrontmatterString(markdown, "zotero_uri"),
    nativeNoteCount: Number.isFinite(nativeNoteCount) ? nativeNoteCount : 0,
    lastSynced: readFrontmatterString(markdown, "last_synced") || now
  };
}

function addStandaloneNoteIndexItem(index: ZoteroObsidianIndex, path: string, markdown: string, now: string): void {
  const noteKey = readFrontmatterString(markdown, "zotero_note_key");
  const parentKey = readFrontmatterString(markdown, "zotero_parent_key");
  if (!noteKey || parentKey) return;

  index.standaloneNotes[noteKey] = {
    noteKey,
    parentItemKey: null,
    path,
    title: readFrontmatterString(markdown, "title") || titleFromPath(path),
    zoteroUri: readFrontmatterString(markdown, "zotero_uri"),
    lastSynced: readFrontmatterString(markdown, "last_synced") || now,
    deleted: readFrontmatterString(markdown, "zotero_note_deleted") === "true"
  };
}

function citationFromFrontmatter(markdown: string, citekey: string): ZoteroCitationMetadata {
  return {
    citekey,
    aliases: readFrontmatterStringArray(markdown, "citation_aliases"),
    citekeySource: citekeySourceFromFrontmatter(readFrontmatterString(markdown, "citekey_source")),
    apaInText: readFrontmatterString(markdown, "citation_apa"),
    apaReference: readFrontmatterString(markdown, "reference_apa"),
    bibtex: readFrontmatterString(markdown, "bibtex")
  };
}

function citekeySourceFromFrontmatter(value: string | undefined): ZoteroCitationMetadata["citekeySource"] {
  return value === "explicit" || value === "generated" ? value : undefined;
}

function titleFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/i, "") || "Untitled";
}
