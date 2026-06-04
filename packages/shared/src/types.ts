export type ZoteroLibraryType = "user" | "group";
export type LibraryScope = "all" | ZoteroLibraryType;
export type DeleteBehavior = "mark" | "archive" | "ignore";

export interface ZoteroBridgeStatus {
  ok: boolean;
  plugin: string;
  version: string;
  zoteroVersion?: string;
  schemaVersion: number;
  generatedAt: string;
}

export interface ZoteroSnapshotLibrary {
  id: number | string;
  type: ZoteroLibraryType;
  name?: string;
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parentKey?: string;
  path: string[];
  itemKeys: string[];
  version?: number;
  deleted?: boolean;
}

export interface ZoteroAttachment {
  key: string;
  title?: string;
  fileName?: string;
  mimeType?: string;
  zoteroUri?: string;
}

export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType?: string;
}

export interface ZoteroCitationMetadata {
  citekey: string;
  aliases?: string[];
  citekeySource?: "explicit" | "generated";
  apaInText?: string;
  apaReference?: string;
  bibtex?: string;
}

export interface ZoteroItem {
  key: string;
  library: ZoteroSnapshotLibrary;
  citekey?: string;
  citation?: ZoteroCitationMetadata;
  title: string;
  creators: ZoteroCreator[];
  year?: string;
  itemType: string;
  publicationTitle?: string;
  doi?: string;
  url?: string;
  collectionKeys: string[];
  tags: string[];
  zoteroUri?: string;
  pdfUri?: string;
  attachments: ZoteroAttachment[];
  version?: number;
  dateModified?: string;
  deleted?: boolean;
}

export interface ZoteroNativeNote {
  key: string;
  library: ZoteroSnapshotLibrary;
  parentItemKey?: string;
  title?: string;
  noteHtml: string;
  zoteroUri?: string;
  version?: number;
  dateModified?: string;
  deleted?: boolean;
}

export interface ZoteroBridgeSnapshot {
  schemaVersion: number;
  generatedAt: string;
  library: ZoteroSnapshotLibrary;
  collections: ZoteroCollection[];
  items: ZoteroItem[];
  nativeNotes?: ZoteroNativeNote[];
}

export interface SyncSettings {
  targetFolder: string;
  papersFolderName: string;
  collectionsFolderName: string;
  standaloneNotesFolderName: string;
  archiveDeletedFolderName: string;
  filenameTemplate: string;
  libraryScope: LibraryScope;
  deleteBehavior: DeleteBehavior;
}

export interface SyncOptions {
  dryRun?: boolean;
  now?: string;
}

export interface NoteRecord {
  path: string;
  content: string;
}

export interface NoteStore {
  listMarkdownFiles(rootPath: string): Promise<NoteRecord[]>;
  read(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  ensureFolder(path: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  move?(fromPath: string, toPath: string): Promise<void>;
}

export interface SyncOperation {
  action:
    | "create-paper"
    | "update-paper"
    | "unchanged-paper"
    | "create-standalone-note"
    | "update-standalone-note"
    | "unchanged-standalone-note"
    | "write-index"
    | "write-obsidian-index"
    | "write-search-index"
    | "mark-deleted"
    | "mark-note-deleted"
    | "archive-deleted";
  path: string;
  itemKey?: string;
  noteKey?: string;
  collectionKey?: string;
}

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  nativeNotesSynced: number;
  standaloneNotesCreated: number;
  standaloneNotesUpdated: number;
  standaloneNotesUnchanged: number;
  indexesWritten: number;
  obsidianIndexWritten: number;
  searchIndexWritten: number;
  deletedMarked: number;
  standaloneNotesDeletedMarked: number;
  archived: number;
  operations: SyncOperation[];
}

export interface ZoteroObsidianIndexItem {
  itemKey: string;
  path: string;
  title: string;
  citekey?: string;
  citation?: ZoteroCitationMetadata;
  zoteroUri?: string;
  nativeNoteCount: number;
  lastSynced: string;
}

export interface ZoteroObsidianIndexStandaloneNote {
  noteKey: string;
  parentItemKey: null;
  path: string;
  title: string;
  zoteroUri?: string;
  lastSynced: string;
  deleted?: boolean;
}

export interface ZoteroObsidianIndex {
  schemaVersion: number;
  generatedAt: string;
  targetFolder: string;
  papersFolderName: string;
  standaloneNotesFolderName: string;
  items: Record<string, ZoteroObsidianIndexItem>;
  standaloneNotes: Record<string, ZoteroObsidianIndexStandaloneNote>;
}

export interface ZoteroObsidianSearchIndexEntry {
  kind: "paper" | "standalone-note";
  path: string;
  title: string;
  citekey?: string;
  year?: string;
  itemKey?: string;
  noteKey?: string;
  zoteroUri?: string;
  updatedAt: string;
  content: string;
}

export interface ZoteroObsidianSearchIndex {
  schemaVersion: number;
  generatedAt: string;
  targetFolder: string;
  entries: ZoteroObsidianSearchIndexEntry[];
}

export interface ZoteroCitationItem {
  itemKey: string;
  citekey: string;
  title: string;
  path?: string;
  citation: ZoteroCitationMetadata;
}

export interface ZoteroCitationGroupResult {
  citekeys: string[];
  rendered: string;
  missing: string[];
  items: ZoteroCitationItem[];
}

export interface ZoteroCitationResponse {
  ok: boolean;
  schemaVersion: number;
  style: string;
  generatedAt: string;
  groups: ZoteroCitationGroupResult[];
  bibliography: string[];
  entries: ZoteroCitationItem[];
  missingCitekeys: string[];
  source?: "zotero" | "snapshot-cache" | "obsidian-index" | "missing";
  error?: string;
}
