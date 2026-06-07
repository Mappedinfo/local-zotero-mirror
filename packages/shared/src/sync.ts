import {
  dirname,
  ensureUniquePath,
  makePaperFileName,
  normalizeVaultPath,
  sanitizePathSegment,
  uniquePathKey
} from "./format.ts";
import { readFrontmatterString, readFrontmatterStringArray } from "./frontmatter.ts";
import {
  mergeExistingPaperNote,
  mergeExistingStandaloneNativeNote,
  renderCollectionIndex,
  renderNewPaperNote,
  renderNewPaperNoteWithNativeNotes,
  renderNewStandaloneNativeNote
} from "./templates.ts";
import type {
  DeleteBehavior,
  NoteRecord,
  NoteStore,
  SyncOptions,
  SyncResult,
  SyncSettings,
  ZoteroBridgeSnapshot,
  ZoteroCollection,
  ZoteroItem,
  ZoteroNativeNote,
  ZoteroObsidianIndex,
  ZoteroObsidianSearchIndex
} from "./types.ts";

export const OBSIDIAN_ZOTERO_INDEX_FILE_NAME = ".obsidian-zotero-index.json";
export const OBSIDIAN_ZOTERO_SEARCH_INDEX_FILE_NAME = ".obsidian-zotero-search-index.json";

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  targetFolder: "Zotero",
  papersFolderName: "Papers",
  collectionsFolderName: "Collections",
  standaloneNotesFolderName: "Zotero原生独立笔记",
  archiveDeletedFolderName: "_Deleted",
  filenameTemplate: "{year} - {firstAuthor} - {title}",
  libraryScope: "all",
  deleteBehavior: "mark"
};

export async function syncSnapshotToStore(
  snapshot: ZoteroBridgeSnapshot,
  store: NoteStore,
  settingsInput: Partial<SyncSettings> = {},
  options: SyncOptions = {}
): Promise<SyncResult> {
  const settings = normalizeSettings(settingsInput);
  const now = options.now ?? new Date().toISOString();
  const dryRun = options.dryRun ?? false;
  const result: SyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    nativeNotesSynced: 0,
    standaloneNotesCreated: 0,
    standaloneNotesUpdated: 0,
    standaloneNotesUnchanged: 0,
    indexesWritten: 0,
    obsidianIndexWritten: 0,
    searchIndexWritten: 0,
    deletedMarked: 0,
    standaloneNotesDeletedMarked: 0,
    archived: 0,
    operations: []
  };

  const existingRecords = await store.listMarkdownFiles(settings.targetFolder);
  const existingByItemKey = mapExistingPaperNotes(existingRecords);
  const existingByStandaloneNoteKey = mapExistingStandaloneNotes(existingRecords);
  const collectionLabelsByKey = buildCollectionLabelsByKey(snapshot.collections);
  const notePathsByItemKey = new Map<string, string>();
  const standaloneNotePathsByKey = new Map<string, string>();
  const noteContentsByPath = new Map<string, string>();
  const usedPaths = new Set(existingRecords.map((record) => uniquePathKey(record.path)));
  const activeItems = snapshot.items.filter((item) => includeItem(item, settings.libraryScope));
  const activeItemKeys = new Set(activeItems.map((item) => item.key));
  const nativeNotes = (snapshot.nativeNotes ?? []).filter((note) => includeNativeNote(note, settings.libraryScope));
  const nativeNotesByParentItemKey = groupNativeNotesByParent(nativeNotes, activeItemKeys);
  const activeStandaloneNotes = nativeNotes.filter((note) => !note.deleted && !note.parentItemKey);
  result.nativeNotesSynced =
    activeStandaloneNotes.length +
    [...nativeNotesByParentItemKey.values()].reduce((total, notes) => total + notes.length, 0);

  for (const item of activeItems) {
    const existing = existingByItemKey.get(item.key);
    const path =
      existing?.path ??
      ensureUniquePath(
        `${settings.targetFolder}/${settings.papersFolderName}/${makePaperFileName(item, settings.filenameTemplate)}`,
        usedPaths
      );
    notePathsByItemKey.set(item.key, path);
  }

  for (const item of activeItems) {
    const existing = existingByItemKey.get(item.key);
    const path = notePathsByItemKey.get(item.key)!;
    const collectionLabels = labelsForItem(item, collectionLabelsByKey);
    const itemNativeNotes = nativeNotesByParentItemKey.get(item.key) ?? [];
    const renderContent = (syncTime: string) =>
      existing
        ? mergeExistingPaperNote(existing.content, item, syncTime, collectionLabels, false, itemNativeNotes)
        : itemNativeNotes.length > 0
          ? renderNewPaperNoteWithNativeNotes(item, syncTime, collectionLabels, itemNativeNotes)
          : renderNewPaperNote(item, syncTime, collectionLabels);
    const nextContent = existing ? preserveTimestampOnlyPaperNote(existing.content, renderContent, now) : renderContent(now);
    noteContentsByPath.set(path, nextContent);

    if (!existing) {
      result.created += 1;
      result.operations.push({ action: "create-paper", path, itemKey: item.key });
      await writeIfNeeded(store, path, nextContent, dryRun);
    } else if (existing.content !== nextContent) {
      result.updated += 1;
      result.operations.push({ action: "update-paper", path, itemKey: item.key });
      await writeIfNeeded(store, path, nextContent, dryRun);
    } else {
      result.unchanged += 1;
      result.operations.push({ action: "unchanged-paper", path, itemKey: item.key });
    }
  }

  await writeStandaloneNativeNotes({
    activeStandaloneNotes,
    existingByStandaloneNoteKey,
    standaloneNotePathsByKey,
    noteContentsByPath,
    usedPaths,
    settings,
    store,
    now,
    dryRun,
    result
  });

  await handleDeletedItems({
    existingByItemKey,
    activeItemKeys,
    settings,
    store,
    now,
    dryRun,
    result
  });

  await writeCollectionIndexes({
    snapshot,
    activeItems,
    notePathsByItemKey,
    settings,
    store,
    now,
    dryRun,
    result
  });

  await writeObsidianIndex({
    activeItems,
    notePathsByItemKey,
    nativeNotesByParentItemKey,
    activeStandaloneNotes,
    standaloneNotePathsByKey,
    noteContentsByPath,
    settings,
    store,
    now,
    dryRun,
    result
  });

  await writeSearchIndex({
    activeItems,
    notePathsByItemKey,
    activeStandaloneNotes,
    standaloneNotePathsByKey,
    noteContentsByPath,
    settings,
    store,
    now,
    dryRun,
    result
  });

  return result;
}

export function normalizeSettings(settings: Partial<SyncSettings>): SyncSettings {
  return {
    ...DEFAULT_SYNC_SETTINGS,
    ...settings,
    targetFolder: normalizeVaultPath(settings.targetFolder || DEFAULT_SYNC_SETTINGS.targetFolder),
    papersFolderName: sanitizePathSegment(settings.papersFolderName || DEFAULT_SYNC_SETTINGS.papersFolderName),
    collectionsFolderName: sanitizePathSegment(
      settings.collectionsFolderName || DEFAULT_SYNC_SETTINGS.collectionsFolderName
    ),
    standaloneNotesFolderName: sanitizePathSegment(
      settings.standaloneNotesFolderName || DEFAULT_SYNC_SETTINGS.standaloneNotesFolderName
    ),
    archiveDeletedFolderName: sanitizePathSegment(
      settings.archiveDeletedFolderName || DEFAULT_SYNC_SETTINGS.archiveDeletedFolderName
    ),
    filenameTemplate: settings.filenameTemplate || DEFAULT_SYNC_SETTINGS.filenameTemplate,
    deleteBehavior: settings.deleteBehavior || DEFAULT_SYNC_SETTINGS.deleteBehavior,
    obsidianIndexPath: settings.obsidianIndexPath ? normalizeVaultPath(settings.obsidianIndexPath) : undefined,
    obsidianSearchIndexPath: settings.obsidianSearchIndexPath
      ? normalizeVaultPath(settings.obsidianSearchIndexPath)
      : undefined
  };
}

function mapExistingPaperNotes(records: NoteRecord[]): Map<string, NoteRecord> {
  const byKey = new Map<string, NoteRecord>();
  for (const record of records) {
    const key = readFrontmatterString(record.content, "zotero_key");
    if (key && !byKey.has(key)) {
      byKey.set(key, record);
    }
  }
  return byKey;
}

function mapExistingStandaloneNotes(records: NoteRecord[]): Map<string, NoteRecord> {
  const byKey = new Map<string, NoteRecord>();
  for (const record of records) {
    const key = readFrontmatterString(record.content, "zotero_note_key");
    if (key && !byKey.has(key)) {
      byKey.set(key, record);
    }
  }
  return byKey;
}

function buildCollectionLabelsByKey(collections: ZoteroCollection[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const collection of collections) {
    labels.set(collection.key, collection.path.length > 0 ? collection.path.join(" / ") : collection.name);
  }
  return labels;
}

function labelsForItem(item: ZoteroItem, collectionLabelsByKey: Map<string, string>): string[] {
  return item.collectionKeys
    .map((key) => collectionLabelsByKey.get(key))
    .filter((label): label is string => Boolean(label));
}

function includeItem(item: ZoteroItem, scope: SyncSettings["libraryScope"]): boolean {
  return !item.deleted && (scope === "all" || item.library.type === scope);
}

function includeNativeNote(note: ZoteroNativeNote, scope: SyncSettings["libraryScope"]): boolean {
  return scope === "all" || note.library.type === scope;
}

function groupNativeNotesByParent(
  nativeNotes: ZoteroNativeNote[],
  activeItemKeys: Set<string>
): Map<string, ZoteroNativeNote[]> {
  const grouped = new Map<string, ZoteroNativeNote[]>();

  for (const note of nativeNotes) {
    if (note.deleted || !note.parentItemKey || !activeItemKeys.has(note.parentItemKey)) continue;
    const notes = grouped.get(note.parentItemKey) ?? [];
    notes.push(note);
    grouped.set(note.parentItemKey, notes);
  }

  return grouped;
}

async function writeIfNeeded(store: NoteStore, path: string, content: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const folder = dirname(path);
  if (folder) {
    await store.ensureFolder(folder);
  }
  await store.write(path, content);
}

async function writeIfChanged(store: NoteStore, path: string, content: string, dryRun: boolean): Promise<boolean> {
  if ((await store.read(path)) === content) return false;
  await writeIfNeeded(store, path, content, dryRun);
  return true;
}

async function writeJsonIfMeaningfullyChanged(
  store: NoteStore,
  path: string,
  content: string,
  normalize: (content: string) => string,
  dryRun: boolean
): Promise<boolean> {
  const existing = await store.read(path);
  if (existing !== null && normalize(existing) === normalize(content)) return false;
  await writeIfNeeded(store, path, content, dryRun);
  return true;
}

function preserveTimestampOnlyPaperNote(
  existing: string,
  renderContent: (syncTime: string) => string,
  now: string
): string {
  const next = renderContent(now);
  if (next === existing) return next;
  const previousSyncTime = readFrontmatterString(existing, "last_synced");
  if (!previousSyncTime) return next;
  return renderContent(previousSyncTime) === existing ? existing : next;
}

function preserveTimestampOnlyStandaloneNativeNote(
  existing: string,
  renderContent: (syncTime: string) => string,
  now: string
): string {
  const next = renderContent(now);
  if (next === existing) return next;
  const previousSyncTime = readFrontmatterString(existing, "last_synced");
  if (!previousSyncTime) return next;
  return renderContent(previousSyncTime) === existing ? existing : next;
}

function preserveTimestampOnlyCollectionIndex(
  existing: string,
  renderContent: (syncTime: string) => string,
  now: string
): string {
  const next = renderContent(now);
  if (next === existing) return next;
  const previousSyncTime = readFrontmatterString(existing, "last_synced");
  if (!previousSyncTime) return next;
  return renderContent(previousSyncTime) === existing ? existing : next;
}

async function handleDeletedItems(args: {
  existingByItemKey: Map<string, NoteRecord>;
  activeItemKeys: Set<string>;
  settings: SyncSettings;
  store: NoteStore;
  now: string;
  dryRun: boolean;
  result: SyncResult;
}): Promise<void> {
  const { existingByItemKey, activeItemKeys, settings, store, now, dryRun, result } = args;

  for (const [itemKey, existing] of existingByItemKey.entries()) {
    if (activeItemKeys.has(itemKey) || settings.deleteBehavior === "ignore") continue;

    if (settings.deleteBehavior === "archive") {
      const archivePath = ensureUniquePath(
        `${settings.targetFolder}/${settings.archiveDeletedFolderName}/${existing.path.split("/").pop()}`,
        new Set()
      );
      result.archived += 1;
      result.operations.push({ action: "archive-deleted", path: archivePath, itemKey });
      if (!dryRun && store.move) {
        await store.ensureFolder(dirname(archivePath));
        await store.move(existing.path, archivePath);
      }
      continue;
    }

    const tombstone = itemFromExistingNote(itemKey, existing.content);
    const nextContent = mergeExistingPaperNote(existing.content, tombstone, now, [], true);
    if (nextContent !== existing.content) {
      result.deletedMarked += 1;
      result.operations.push({ action: "mark-deleted", path: existing.path, itemKey });
      await writeIfNeeded(store, existing.path, nextContent, dryRun);
    }
  }
}

async function writeStandaloneNativeNotes(args: {
  activeStandaloneNotes: ZoteroNativeNote[];
  existingByStandaloneNoteKey: Map<string, NoteRecord>;
  standaloneNotePathsByKey: Map<string, string>;
  noteContentsByPath: Map<string, string>;
  usedPaths: Set<string>;
  settings: SyncSettings;
  store: NoteStore;
  now: string;
  dryRun: boolean;
  result: SyncResult;
}): Promise<void> {
  const {
    activeStandaloneNotes,
    existingByStandaloneNoteKey,
    standaloneNotePathsByKey,
    noteContentsByPath,
    usedPaths,
    settings,
    store,
    now,
    dryRun,
    result
  } = args;
  const activeNoteKeys = new Set(activeStandaloneNotes.map((note) => note.key));

  for (const note of activeStandaloneNotes) {
    const existing = existingByStandaloneNoteKey.get(note.key);
    const path =
      existing?.path ??
      ensureUniquePath(
        `${settings.targetFolder}/${settings.standaloneNotesFolderName}/${makeStandaloneNativeNoteFileName(note)}`,
        usedPaths
      );
    standaloneNotePathsByKey.set(note.key, path);

    const nextContent = existing
      ? preserveTimestampOnlyStandaloneNativeNote(
          existing.content,
          (syncTime) => mergeExistingStandaloneNativeNote(existing.content, note, syncTime, false),
          now
        )
      : renderNewStandaloneNativeNote(note, now);
    noteContentsByPath.set(path, nextContent);

    if (!existing) {
      result.standaloneNotesCreated += 1;
      result.operations.push({ action: "create-standalone-note", path, noteKey: note.key });
      await writeIfNeeded(store, path, nextContent, dryRun);
    } else if (existing.content !== nextContent) {
      result.standaloneNotesUpdated += 1;
      result.operations.push({ action: "update-standalone-note", path, noteKey: note.key });
      await writeIfNeeded(store, path, nextContent, dryRun);
    } else {
      result.standaloneNotesUnchanged += 1;
      result.operations.push({ action: "unchanged-standalone-note", path, noteKey: note.key });
    }
  }

  for (const [noteKey, existing] of existingByStandaloneNoteKey.entries()) {
    if (activeNoteKeys.has(noteKey) || settings.deleteBehavior === "ignore") continue;
    const tombstone = nativeNoteFromExistingStandalone(noteKey, existing.content);
    const nextContent = mergeExistingStandaloneNativeNote(existing.content, tombstone, now, true);
    if (nextContent !== existing.content) {
      result.standaloneNotesDeletedMarked += 1;
      result.operations.push({ action: "mark-note-deleted", path: existing.path, noteKey });
      await writeIfNeeded(store, existing.path, nextContent, dryRun);
    }
  }
}

async function writeCollectionIndexes(args: {
  snapshot: ZoteroBridgeSnapshot;
  activeItems: ZoteroItem[];
  notePathsByItemKey: Map<string, string>;
  settings: SyncSettings;
  store: NoteStore;
  now: string;
  dryRun: boolean;
  result: SyncResult;
}): Promise<void> {
  const { snapshot, activeItems, notePathsByItemKey, settings, store, now, dryRun, result } = args;
  const itemsByKey = new Map(activeItems.map((item) => [item.key, item]));
  const usedIndexPaths = new Set<string>();

  for (const collection of snapshot.collections.filter((entry) => !entry.deleted)) {
    const members = collection.itemKeys
      .map((key) => itemsByKey.get(key))
      .filter((item): item is ZoteroItem => Boolean(item));
    const indexPath = ensureUniquePath(collectionIndexPath(settings, collection), usedIndexPaths);
    const renderContent = (syncTime: string) => renderCollectionIndex(collection, members, notePathsByItemKey, syncTime);
    const existing = await store.read(indexPath);
    const content = existing ? preserveTimestampOnlyCollectionIndex(existing, renderContent, now) : renderContent(now);
    if (await writeIfChanged(store, indexPath, content, dryRun)) {
      result.indexesWritten += 1;
      result.operations.push({ action: "write-index", path: indexPath, collectionKey: collection.key });
    }
  }
}

async function writeObsidianIndex(args: {
  activeItems: ZoteroItem[];
  notePathsByItemKey: Map<string, string>;
  nativeNotesByParentItemKey: Map<string, ZoteroNativeNote[]>;
  activeStandaloneNotes: ZoteroNativeNote[];
  standaloneNotePathsByKey: Map<string, string>;
  noteContentsByPath: Map<string, string>;
  settings: SyncSettings;
  store: NoteStore;
  now: string;
  dryRun: boolean;
  result: SyncResult;
}): Promise<void> {
  const {
    activeItems,
    notePathsByItemKey,
    nativeNotesByParentItemKey,
    activeStandaloneNotes,
    standaloneNotePathsByKey,
    noteContentsByPath,
    settings,
    store,
    now,
    dryRun,
    result
  } = args;
  const index: ZoteroObsidianIndex = {
    schemaVersion: 1,
    generatedAt: now,
    targetFolder: settings.targetFolder,
    papersFolderName: settings.papersFolderName,
    standaloneNotesFolderName: settings.standaloneNotesFolderName,
    items: {},
    standaloneNotes: {}
  };

  for (const item of activeItems) {
    const path = notePathsByItemKey.get(item.key);
    if (!path) continue;
    const content = noteContentsByPath.get(path) || "";
    index.items[item.key] = {
      itemKey: item.key,
      path,
      title: item.title,
      citekey: item.citekey,
      citation: item.citation,
      zoteroUri: item.zoteroUri,
      nativeNoteCount: nativeNotesByParentItemKey.get(item.key)?.length ?? 0,
      obsidianNoteKey: readFrontmatterString(content, "obsidian_note_key"),
      obsidianNoteHash: readFrontmatterString(content, "obsidian_note_hash"),
      obsidianNoteSyncStatus: readFrontmatterString(content, "obsidian_note_sync_status"),
      lastSynced: now
    };
  }

  for (const note of activeStandaloneNotes) {
    const path = standaloneNotePathsByKey.get(note.key);
    if (!path) continue;
    index.standaloneNotes[note.key] = {
      noteKey: note.key,
      parentItemKey: null,
      path,
      title: note.title || `Zotero note ${note.key}`,
      zoteroUri: note.zoteroUri,
      lastSynced: now
    };
  }

  const path = settings.obsidianIndexPath || normalizeVaultPath(`${settings.targetFolder}/${OBSIDIAN_ZOTERO_INDEX_FILE_NAME}`);
  const content = `${JSON.stringify(index, null, 2)}\n`;
  if (await writeJsonIfMeaningfullyChanged(store, path, content, normalizeObsidianIndexForComparison, dryRun)) {
    result.obsidianIndexWritten += 1;
    result.operations.push({ action: "write-obsidian-index", path });
  }
}

async function writeSearchIndex(args: {
  activeItems: ZoteroItem[];
  notePathsByItemKey: Map<string, string>;
  activeStandaloneNotes: ZoteroNativeNote[];
  standaloneNotePathsByKey: Map<string, string>;
  noteContentsByPath: Map<string, string>;
  settings: SyncSettings;
  store: NoteStore;
  now: string;
  dryRun: boolean;
  result: SyncResult;
}): Promise<void> {
  const {
    activeItems,
    notePathsByItemKey,
    activeStandaloneNotes,
    standaloneNotePathsByKey,
    noteContentsByPath,
    settings,
    store,
    now,
    dryRun,
    result
  } = args;
  const searchIndex: ZoteroObsidianSearchIndex = {
    schemaVersion: 1,
    generatedAt: now,
    targetFolder: settings.targetFolder,
    entries: []
  };

  for (const item of activeItems) {
    const path = notePathsByItemKey.get(item.key);
    if (!path) continue;
    const content = noteContentsByPath.get(path);
    if (content === undefined) continue;
    searchIndex.entries.push({
      kind: "paper",
      path,
      title: item.title,
      citekey: item.citekey,
      year: item.year,
      itemKey: item.key,
      zoteroUri: item.zoteroUri,
      updatedAt: now,
      content: normalizeSearchIndexContent(content)
    });
  }

  for (const note of activeStandaloneNotes) {
    const path = standaloneNotePathsByKey.get(note.key);
    if (!path) continue;
    const content = noteContentsByPath.get(path);
    if (content === undefined) continue;
    searchIndex.entries.push({
      kind: "standalone-note",
      path,
      title: note.title || `Zotero note ${note.key}`,
      noteKey: note.key,
      zoteroUri: note.zoteroUri,
      updatedAt: now,
      content: normalizeSearchIndexContent(content)
    });
  }

  const path =
    settings.obsidianSearchIndexPath || normalizeVaultPath(`${settings.targetFolder}/${OBSIDIAN_ZOTERO_SEARCH_INDEX_FILE_NAME}`);
  const content = `${JSON.stringify(searchIndex, null, 2)}\n`;
  if (await writeJsonIfMeaningfullyChanged(store, path, content, normalizeSearchIndexForComparison, dryRun)) {
    result.searchIndexWritten += 1;
    result.operations.push({ action: "write-search-index", path });
  }
}

function normalizeSearchIndexContent(markdown: string): string {
  return String(markdown || "")
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function normalizeObsidianIndexForComparison(content: string): string {
  return normalizeJsonForComparison(content, (value) => {
    if (!isRecord(value)) return value;
    delete value.generatedAt;
    for (const item of Object.values(asRecord(value.items))) {
      if (isRecord(item)) delete item.lastSynced;
    }
    for (const note of Object.values(asRecord(value.standaloneNotes))) {
      if (isRecord(note)) delete note.lastSynced;
    }
    return value;
  });
}

function normalizeSearchIndexForComparison(content: string): string {
  return normalizeJsonForComparison(content, (value) => {
    if (!isRecord(value)) return value;
    delete value.generatedAt;
    const entries = Array.isArray(value.entries) ? value.entries : [];
    for (const entry of entries) {
      if (isRecord(entry)) delete entry.updatedAt;
    }
    return value;
  });
}

function normalizeJsonForComparison(content: string, transform: (value: unknown) => unknown): string {
  try {
    return JSON.stringify(transform(JSON.parse(content)));
  } catch {
    return content;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function collectionIndexPath(settings: SyncSettings, collection: ZoteroCollection): string {
  const pathParts = collection.path.length > 0 ? collection.path : [collection.name];
  const safeParts = pathParts.map(sanitizePathSegment);
  const fileName = `${safeParts.pop() || sanitizePathSegment(collection.name)}.md`;
  return normalizeVaultPath(
    [settings.targetFolder, settings.collectionsFolderName, ...safeParts, fileName].join("/")
  );
}

function itemFromExistingNote(key: string, content: string): ZoteroItem {
  return {
    key,
    library: { id: "unknown", type: "user" },
    title: readFrontmatterString(content, "title") || "Deleted Zotero item",
    citekey: readFrontmatterString(content, "citekey"),
    citation: {
      citekey: readFrontmatterString(content, "citekey") || key,
      aliases: readFrontmatterStringArray(content, "citation_aliases"),
      citekeySource: readCitekeySource(content),
      apaInText: readFrontmatterString(content, "citation_apa"),
      apaReference: readFrontmatterString(content, "reference_apa"),
      bibtex: readFrontmatterString(content, "bibtex")
    },
    creators: [],
    year: readFrontmatterString(content, "year"),
    itemType: readFrontmatterString(content, "item_type") || "unknown",
    publicationTitle: readFrontmatterString(content, "publication"),
    doi: readFrontmatterString(content, "doi"),
    url: readFrontmatterString(content, "url"),
    collectionKeys: [],
    tags: [],
    zoteroUri: readFrontmatterString(content, "zotero_uri"),
    pdfUri: readFrontmatterString(content, "pdf_uri"),
    attachments: [],
    deleted: true
  };
}

function readCitekeySource(content: string): "explicit" | "generated" | undefined {
  const source = readFrontmatterString(content, "citekey_source");
  return source === "explicit" || source === "generated" ? source : undefined;
}

function makeStandaloneNativeNoteFileName(note: ZoteroNativeNote): string {
  const title = note.title || "Zotero native note";
  return `${sanitizePathSegment(`${title} - ${note.key}`)}.md`;
}

function nativeNoteFromExistingStandalone(key: string, content: string): ZoteroNativeNote {
  return {
    key,
    library: { id: "unknown", type: "user" },
    title: readFrontmatterString(content, "title") || `Zotero note ${key}`,
    noteHtml: "",
    zoteroUri: readFrontmatterString(content, "zotero_uri"),
    deleted: true
  };
}
