import {
  App,
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  editorInfoField,
  editorLivePreviewField,
  normalizePath,
  requestUrl
} from "obsidian";
import type { MarkdownPostProcessorContext } from "obsidian";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  DEFAULT_SYNC_SETTINGS,
  OBSIDIAN_ZOTERO_INDEX_FILE_NAME,
  assertZoteroSnapshot,
  buildCitationRenderRanges,
  citationActionState,
  citationGroupKey,
  dirname,
  findObsidianIndexItemForCitation,
  findPandocCitationGroups,
  readFrontmatterString,
  readFrontmatterStringArray,
  syncSnapshotToStore,
  uniqueCitationGroups,
  type DeleteBehavior,
  type LibraryScope,
  type NoteRecord,
  type NoteStore,
  type SyncSettings,
  type ZoteroBridgeSnapshot,
  type ZoteroBridgeStatus,
  type ZoteroCitationItem,
  type CurrentCitationActionState,
  type ZoteroCitationMetadata,
  type ZoteroCitationResponse,
  type ZoteroObsidianIndex
} from "../packages/shared/src/index.ts";

type ZoteroUriField = "zotero_uri" | "pdf_uri";
type ElectronShell = { openExternal: (uri: string) => Promise<void> };

interface CitationDocumentState {
  sourcePath: string;
  markdown: string;
  groups: string[][];
  response: ZoteroCitationResponse | null;
  updatedAt: number;
}

interface CurrentCitationPanelEntry {
  citekey: string;
  title: string;
  apaReference?: string;
  notePath?: string;
  zoteroUri?: string;
  pdfUri?: string;
}

interface CurrentCitationsPanelData {
  file: TFile | null;
  sourcePath: string;
  response: ZoteroCitationResponse | null;
  entries: CurrentCitationPanelEntry[];
  missingCitekeys: string[];
}

interface ConnectorSettings extends SyncSettings {
  bridgeUrl: string;
  syncIntervalMinutes: number;
  dryRunPreview: boolean;
}

const DEFAULT_SETTINGS: ConnectorSettings = {
  ...DEFAULT_SYNC_SETTINGS,
  bridgeUrl: "http://127.0.0.1:23119/obsidian-zotero",
  syncIntervalMinutes: 30,
  dryRunPreview: false
};

const CURRENT_CITATIONS_VIEW_TYPE = "local-zotero-current-citations";
const CITATION_WIDGET_CLASS = "local-zotero-editor-citation";
const citationRenderEffect = StateEffect.define<CitationDocumentState | null>();
const citationDocumentStateField = StateField.define<CitationDocumentState | null>({
  create: () => null,
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(citationRenderEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

export default class ObsidianZoteroConnectorPlugin extends Plugin {
  settings: ConnectorSettings = DEFAULT_SETTINGS;
  private citationCache = new Map<string, ZoteroCitationResponse>();
  private lastSnapshot: ZoteroBridgeSnapshot | null = null;
  private referenceRenderTimers = new Map<string, number>();
  private editorViews = new Set<EditorView>();
  private editorResolveTimers = new Map<string, number>();
  private currentCitationsRefreshTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ConnectorSettingTab(this.app, this));
    this.registerView(CURRENT_CITATIONS_VIEW_TYPE, (leaf) => new CurrentCitationsView(leaf, this));
    this.registerEditorExtension(createCitationEditorExtension(this));

    this.addCommand({
      id: "sync-zotero-library",
      name: "Sync Zotero Library",
      callback: () => this.runSync({ dryRun: false })
    });

    this.addCommand({
      id: "preview-zotero-sync",
      name: "Preview Zotero Sync",
      callback: () => this.runSync({ dryRun: true })
    });

    this.addCommand({
      id: "open-zotero-item",
      name: "Open Zotero Item",
      callback: () => this.openActiveZoteroItem()
    });

    this.addCommand({
      id: "open-zotero-pdf",
      name: "Open Zotero PDF",
      callback: () => this.openActiveZoteroPdf()
    });

    this.addCommand({
      id: "rebuild-collection-indexes",
      name: "Rebuild Collection Indexes",
      callback: () => this.runSync({ dryRun: false })
    });

    this.addCommand({
      id: "open-current-citations-panel",
      name: "Open Current Citations Panel",
      callback: () => this.openCurrentCitationsPanel()
    });

    this.registerContextMenus();
    this.registerMarkdownPostProcessor((element, context) => this.renderPandocCitations(element, context));
    this.registerCitationPanelEvents();
    this.registerConfiguredInterval();
    this.app.workspace.onLayoutReady(() => {
      void this.openCurrentCitationsPanel({ reveal: false });
      this.scheduleCurrentCitationsPanelRefresh();
    });
  }

  onunload(): void {
    for (const timer of this.editorResolveTimers.values()) {
      window.clearTimeout(timer);
    }
    this.editorResolveTimers.clear();
    if (this.currentCitationsRefreshTimer !== null) {
      window.clearTimeout(this.currentCitationsRefreshTimer);
      this.currentCitationsRefreshTimer = null;
    }
    this.app.workspace.detachLeavesOfType(CURRENT_CITATIONS_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData())
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async fetchStatus(): Promise<ZoteroBridgeStatus> {
    return fetchBridgeJson<ZoteroBridgeStatus>(`${trimSlash(this.settings.bridgeUrl)}/status`);
  }

  async fetchSnapshot(): Promise<ZoteroBridgeSnapshot> {
    const bridgeUrl = new URL(`${trimSlash(this.settings.bridgeUrl)}/snapshot`);
    bridgeUrl.searchParams.set("scope", this.settings.libraryScope);

    const snapshot = await fetchBridgeJson<unknown>(bridgeUrl.toString());
    assertZoteroSnapshot(snapshot);
    this.lastSnapshot = snapshot;
    this.citationCache.clear();
    return snapshot;
  }

  async runSync(options: { dryRun: boolean; silent?: boolean }): Promise<void> {
    try {
      const snapshot = await this.fetchSnapshot();
      const store = new ObsidianNoteStore(this.app);
      const result = await syncSnapshotToStore(snapshot, store, this.settings, {
        dryRun: options.dryRun,
        now: new Date().toISOString()
      });

      const verb = options.dryRun ? "Previewed" : "Synced";
      const summary = `${verb}: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.indexesWritten} indexes.`;
      console.info("[local-zotero-mirror]", summary, result.operations);
      if (!options.silent) {
        new Notice(summary);
      }
    } catch (error) {
      console.error("[local-zotero-mirror] Sync failed", error);
      if (!options.silent) {
        new Notice(`Zotero sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  openActiveZoteroItem(): void {
    this.openZoteroUriFromFile(this.app.workspace.getActiveFile(), "zotero_uri", {
      noFileMessage: "No active note.",
      missingLinkMessage: "This note has no Zotero item link."
    });
  }

  openActiveZoteroPdf(): void {
    this.openZoteroUriFromFile(this.app.workspace.getActiveFile(), "pdf_uri", {
      noFileMessage: "No active note.",
      missingLinkMessage: "This note has no Zotero PDF link."
    });
  }

  registerEditorView(view: EditorView): void {
    this.editorViews.add(view);
    this.scheduleEditorCitationResolve(view);
  }

  unregisterEditorView(view: EditorView): void {
    this.editorViews.delete(view);
  }

  scheduleEditorCitationResolve(view: EditorView): void {
    const sourcePath = sourcePathFromEditorView(view);
    if (!sourcePath) return;
    if (!isLivePreview(view)) return;
    const existing = this.editorResolveTimers.get(sourcePath);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }

    const markdown = view.state.doc.toString();
    const timer = window.setTimeout(() => {
      this.editorResolveTimers.delete(sourcePath);
      void this.resolveCitationDocumentState(sourcePath, markdown)
        .then((state) => {
          this.dispatchCitationStateToEditors(state);
          if (this.app.workspace.getActiveFile()?.path === sourcePath) {
            this.scheduleCurrentCitationsPanelRefresh();
          }
        })
        .catch((error) => {
          console.error("[local-zotero-mirror] Editor citation render failed", error);
          this.dispatchCitationStateToEditors({
            sourcePath,
            markdown,
            groups: uniqueCitationGroups(findPandocCitationGroups(markdown)),
            response: null,
            updatedAt: Date.now()
          });
        });
    }, 250);
    this.editorResolveTimers.set(sourcePath, timer);
  }

  async resolveCitationDocumentState(sourcePath: string, markdown: string): Promise<CitationDocumentState> {
    const groups = uniqueCitationGroups(findPandocCitationGroups(markdown));
    const response = groups.length > 0 ? await this.fetchCitationResponse(groups) : null;
    return {
      sourcePath,
      markdown,
      groups,
      response,
      updatedAt: Date.now()
    };
  }

  async openCurrentCitationsPanel(options: { reveal?: boolean } = { reveal: true }): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(CURRENT_CITATIONS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: CURRENT_CITATIONS_VIEW_TYPE, active: true });
    }
    if (options.reveal !== false) {
      await this.app.workspace.revealLeaf(leaf);
    }
    this.scheduleCurrentCitationsPanelRefresh();
  }

  scheduleCurrentCitationsPanelRefresh(): void {
    if (this.currentCitationsRefreshTimer !== null) {
      window.clearTimeout(this.currentCitationsRefreshTimer);
    }
    this.currentCitationsRefreshTimer = window.setTimeout(() => {
      this.currentCitationsRefreshTimer = null;
      void this.refreshCurrentCitationsPanels();
    }, 150);
  }

  async getCurrentCitationsPanelData(): Promise<CurrentCitationsPanelData> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      return { file: null, sourcePath: "", response: null, entries: [], missingCitekeys: [] };
    }

    const markdown = this.getActiveMarkdownText(file) ?? (await this.app.vault.cachedRead(file));
    const state = await this.resolveCitationDocumentState(file.path, markdown);
    const response = state.response;
    if (!response) {
      return { file, sourcePath: file.path, response: null, entries: [], missingCitekeys: [] };
    }

    const index = await this.readObsidianIndex().catch((error) => {
      console.warn("[local-zotero-mirror] Failed to read Obsidian Zotero index", error);
      return null;
    });
    const entries = await Promise.all(response.entries.map((entry) => this.enrichCitationPanelEntry(entry, index)));
    return {
      file,
      sourcePath: file.path,
      response,
      entries,
      missingCitekeys: response.missingCitekeys
    };
  }

  private registerCitationPanelEvents(): void {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.scheduleCurrentCitationsPanelRefresh();
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        const file = info.file;
        if (file instanceof TFile && file.path === this.app.workspace.getActiveFile()?.path) {
          this.scheduleCurrentCitationsPanelRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === this.app.workspace.getActiveFile()?.path) {
          this.scheduleCurrentCitationsPanelRefresh();
        }
      })
    );
  }

  private async refreshCurrentCitationsPanels(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(CURRENT_CITATIONS_VIEW_TYPE);
    await Promise.all(
      leaves.map(async (leaf) => {
        if (leaf.view instanceof CurrentCitationsView) {
          await leaf.view.refresh();
        }
      })
    );
  }

  private dispatchCitationStateToEditors(state: CitationDocumentState): void {
    for (const view of this.editorViews) {
      if (sourcePathFromEditorView(view) !== state.sourcePath) continue;
      view.dispatch({ effects: citationRenderEffect.of(state) });
    }
  }

  private async enrichCitationPanelEntry(
    entry: ZoteroCitationItem,
    index: ZoteroObsidianIndex | null
  ): Promise<CurrentCitationPanelEntry> {
    const indexItem = findObsidianIndexItemForCitation(entry, index);
    const notePath = entry.path || indexItem?.path;
    const noteFile = notePath ? this.getMarkdownFile(notePath) : await this.findCitationPaperNote(entry);
    return {
      citekey: entry.citekey,
      title: entry.title,
      apaReference: entry.citation.apaReference,
      notePath: notePath || noteFile?.path,
      zoteroUri: indexItem?.zoteroUri || (noteFile ? await this.getFrontmatterUriFromFile(noteFile, "zotero_uri") || undefined : undefined),
      pdfUri: noteFile ? await this.getFrontmatterUriFromFile(noteFile, "pdf_uri") || undefined : undefined
    };
  }

  private async renderPandocCitations(element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> {
    const textNodes = this.collectCitationTextNodes(element);
    const nodeGroups = textNodes
      .map((node) => ({ node, groups: findPandocCitationGroups(node.nodeValue || "") }))
      .filter((entry) => entry.groups.length > 0);

    if (nodeGroups.length === 0) return;

    const groups = uniqueCitationGroups(nodeGroups.flatMap((entry) => entry.groups));
    const response = await this.fetchCitationResponse(groups);
    for (const { node, groups: matches } of nodeGroups) {
      this.replaceCitationTextNode(node, matches, response);
    }
    this.scheduleReferenceRender(context.sourcePath);
  }

  private collectCitationTextNodes(element: HTMLElement): Text[] {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.nodeValue?.includes("[@")) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest("code, pre, a, script, style, .local-zotero-references")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node = walker.nextNode();
    while (node) {
      nodes.push(node as Text);
      node = walker.nextNode();
    }
    return nodes;
  }

  private replaceCitationTextNode(
    node: Text,
    groups: ReturnType<typeof findPandocCitationGroups>,
    response: ZoteroCitationResponse
  ): void {
    const text = node.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let cursor = 0;

    for (const group of groups) {
      fragment.append(document.createTextNode(text.slice(cursor, group.start)));
      fragment.append(this.createCitationSpan(group.citekeys, response));
      cursor = group.end;
    }
    fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }

  private createCitationSpan(citekeys: string[], response: ZoteroCitationResponse): HTMLElement {
    const group = new Map(response.groups.map((entry) => [citationGroupKey(entry.citekeys), entry])).get(
      citationGroupKey(citekeys)
    );
    const missing = group?.missing ?? citekeys;
    const span = document.createElement("span");
    span.className = "local-zotero-citation";
    if (missing.length > 0 || response.source !== "zotero") {
      span.classList.add(missing.length > 0 ? "is-missing" : "is-cached");
    }
    span.textContent = group?.rendered || `[missing: ${citekeys.join(", ")}]`;
    span.title = [
      `Zotero citation: ${citekeys.join(", ")}`,
      missing.length > 0 ? `Missing citekey: ${missing.join(", ")}` : "",
      response.error ? `Citation source warning: ${response.error}` : ""
    ]
      .filter(Boolean)
      .join("\n");
    return span;
  }

  async fetchCitationResponse(groups: string[][]): Promise<ZoteroCitationResponse> {
    const cacheKey = `${this.settings.libraryScope}:apa:${groups.map(citationGroupKey).join("|")}`;
    const cached = this.citationCache.get(cacheKey);
    if (cached?.source === "zotero") return cached;

    const bridgeUrl = new URL(`${trimSlash(this.settings.bridgeUrl)}/citations`);

    try {
      const response = await postBridgeJson<ZoteroCitationResponse>(bridgeUrl.toString(), {
        style: "apa",
        scope: this.settings.libraryScope,
        groups: groups.map((group) => group.join(",")).join("|")
      });
      if (response.groups.length !== groups.length) {
        throw new Error("Zotero bridge returned no citation groups for the requested citekeys.");
      }
      this.citationCache.set(cacheKey, response);
      return response;
    } catch (error) {
      const fallback = await this.buildCitationResponseFromCache(groups, error);
      this.citationCache.set(cacheKey, fallback);
      return fallback;
    }
  }

  private async buildCitationResponseFromCache(groups: string[][], error?: unknown): Promise<ZoteroCitationResponse> {
    const itemsByKey = new Map<string, ZoteroCitationItem>();
    let source: ZoteroCitationResponse["source"] = "missing";

    if (this.lastSnapshot) {
      source = "snapshot-cache";
      for (const item of this.lastSnapshot.items) {
        const citation = item.citation || this.snapshotCitationFallback(item);
        const entry: ZoteroCitationItem = {
          itemKey: item.key,
          citekey: citation.citekey,
          title: item.title,
          citation
        };
        this.registerCitationEntry(itemsByKey, entry, [item.citekey, item.key]);
      }
    }

    const index = await this.readObsidianIndex().catch(() => null);
    if (index) {
      source = source === "missing" ? "obsidian-index" : source;
      for (const item of Object.values(index.items)) {
        if (!item.citation && !item.citekey) continue;
        const citation = item.citation || {
          citekey: item.citekey || item.itemKey
        };
        const entry: ZoteroCitationItem = {
          itemKey: item.itemKey,
          citekey: citation.citekey,
          title: item.title,
          path: item.path,
          citation
        };
        this.registerCitationEntry(itemsByKey, entry, [item.citekey, item.itemKey]);
      }
    }

    const requested = [...new Set(groups.flat())];
    const entries = requested.map((citekey) => itemsByKey.get(citekey)).filter((item): item is ZoteroCitationItem => Boolean(item));
    const missingCitekeys = requested.filter((citekey) => !itemsByKey.has(citekey));
    const groupResults = groups.map((citekeys) => {
      const items = citekeys.map((citekey) => itemsByKey.get(citekey)).filter((item): item is ZoteroCitationItem => Boolean(item));
      const missing = citekeys.filter((citekey) => !itemsByKey.has(citekey));
      return {
        citekeys,
        rendered: this.combineCachedInText(items, missing, citekeys),
        missing,
        items
      };
    });

    return {
      ok: missingCitekeys.length === 0 && entries.length > 0,
      schemaVersion: 1,
      style: "apa",
      generatedAt: new Date().toISOString(),
      groups: groupResults,
      bibliography: entries.map((entry) => entry.citation.apaReference).filter((value): value is string => Boolean(value)),
      entries,
      missingCitekeys,
      source,
      error:
        error === undefined
          ? undefined
          : `Zotero bridge unavailable; rendered from ${source}. ${
              error instanceof Error ? error.message : String(error)
            }`
    };
  }

  private registerCitationEntry(
    itemsByKey: Map<string, ZoteroCitationItem>,
    entry: ZoteroCitationItem,
    legacyKeys: Array<string | undefined> = []
  ): void {
    const keys = [entry.citekey, entry.citation.citekey, ...(entry.citation.aliases ?? []), ...legacyKeys];
    for (const key of new Set(keys.filter((value): value is string => Boolean(value)))) {
      if (!itemsByKey.has(key)) {
        itemsByKey.set(key, entry);
      }
    }
  }

  private snapshotCitationFallback(item: ZoteroBridgeSnapshot["items"][number]): ZoteroCitationMetadata {
    const citekey = item.citekey || item.key;
    const author = item.creators.find((creator) => creator.creatorType === "author") ?? item.creators[0];
    const authorLabel = author?.lastName || author?.name || [author?.firstName, author?.lastName].filter(Boolean).join(" ") || item.title;
    const year = item.year || "n.d.";
    return {
      citekey,
      apaInText: `(${authorLabel}, ${year})`,
      apaReference: `${authorLabel} (${year}). ${item.title}.`,
      bibtex: undefined
    };
  }

  private combineCachedInText(items: ZoteroCitationItem[], missing: string[], citekeys: string[]): string {
    if (items.length === 0) return `[missing: ${citekeys.join(", ")}]`;
    const rendered = items
      .map((item) => stripOuterParens(item.citation.apaInText || `missing: ${item.citekey}`))
      .filter(Boolean)
      .join("; ");
    const suffix = missing.length > 0 ? ` [missing: ${missing.join(", ")}]` : "";
    return `(${rendered})${suffix}`;
  }

  private scheduleReferenceRender(sourcePath: string): void {
    const existing = this.referenceRenderTimers.get(sourcePath);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      this.referenceRenderTimers.delete(sourcePath);
      void this.renderReferencesForFile(sourcePath);
    }, 100);
    this.referenceRenderTimers.set(sourcePath, timer);
  }

  private async renderReferencesForFile(sourcePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    const markdown = await this.app.vault.read(file);
    const groups = uniqueCitationGroups(findPandocCitationGroups(markdown));
    const response = groups.length > 0 ? await this.fetchCitationResponse(groups) : null;

    for (const target of this.findPreviewTargets(sourcePath)) {
      target.querySelectorAll(":scope > .local-zotero-references").forEach((element) => element.remove());
      if (!response || response.entries.length === 0) continue;
      target.append(this.createReferencesBlock(response));
    }
  }

  private findPreviewTargets(sourcePath: string): HTMLElement[] {
    const targets: HTMLElement[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as unknown as { file?: TFile; containerEl?: HTMLElement };
      if (view.file?.path !== sourcePath || !view.containerEl) return;
      const preview = view.containerEl.querySelector<HTMLElement>(".markdown-preview-view");
      const target = preview?.querySelector<HTMLElement>(".markdown-preview-sizer") || preview;
      if (target) targets.push(target);
    });
    return targets;
  }

  private createReferencesBlock(response: ZoteroCitationResponse): HTMLElement {
    const block = document.createElement("section");
    block.className = "local-zotero-references";

    const heading = document.createElement("h2");
    heading.textContent = "References";
    block.append(heading);

    if (response.error || response.source !== "zotero") {
      const status = document.createElement("p");
      status.className = "local-zotero-references-status";
      status.textContent = response.error || `Citation source: ${response.source}`;
      block.append(status);
    }

    if (response.missingCitekeys.length > 0) {
      const missing = document.createElement("p");
      missing.className = "local-zotero-references-missing";
      missing.textContent = `Missing Zotero citekeys: ${response.missingCitekeys.join(", ")}`;
      block.append(missing);
    }

    const list = document.createElement("ol");
    for (const entry of response.bibliography) {
      const item = document.createElement("li");
      item.textContent = entry;
      list.append(item);
    }
    block.append(list);
    return block;
  }

  private async readObsidianIndex(): Promise<ZoteroObsidianIndex | null> {
    const path = normalizePath(`${this.settings.targetFolder}/${OBSIDIAN_ZOTERO_INDEX_FILE_NAME}`);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return JSON.parse(await this.app.vault.read(file)) as ZoteroObsidianIndex;
    }

    if (await this.app.vault.adapter.exists(path)) {
      return JSON.parse(await this.app.vault.adapter.read(path)) as ZoteroObsidianIndex;
    }

    console.warn("[local-zotero-mirror] Obsidian Zotero index not found", { path });
    return null;
  }

  private registerContextMenus(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md" && this.shouldShowZoteroMenuForFile(file)) {
          this.addZoteroContextMenuItems(menu, file);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, info) => {
        const file = info.file;
        if (file instanceof TFile && this.shouldShowZoteroMenuForFile(file)) {
          this.addZoteroContextMenuItems(menu, file);
        }
      })
    );
  }

  private shouldShowZoteroMenuForFile(file: TFile): boolean {
    const targetFolder = normalizePath(this.settings.targetFolder);
    return (
      file.path === targetFolder ||
      file.path.startsWith(`${targetFolder}/`) ||
      this.hasFrontmatterUri(file, "zotero_uri") ||
      this.hasFrontmatterUri(file, "pdf_uri")
    );
  }

  private addZoteroContextMenuItems(menu: Menu, file: TFile): void {
    const hasZoteroItem = this.hasFrontmatterUri(file, "zotero_uri");
    const hasZoteroPdf = this.hasFrontmatterUri(file, "pdf_uri");

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Open Zotero Item")
        .setIcon("external-link")
        .setDisabled(!hasZoteroItem)
        .onClick(() =>
          this.openZoteroUriFromFile(file, "zotero_uri", {
            missingLinkMessage: "This note has no Zotero item link."
          })
        )
    );
    menu.addItem((item) =>
      item
        .setTitle("Open Zotero PDF")
        .setIcon("file-text")
        .setDisabled(!hasZoteroPdf)
        .onClick(() =>
          this.openZoteroUriFromFile(file, "pdf_uri", {
            missingLinkMessage: "This note has no Zotero PDF link."
          })
        )
    );
  }

  private hasFrontmatterUri(file: TFile, field: ZoteroUriField): boolean {
    return this.getFrontmatterUri(file, field) !== null;
  }

  private getFrontmatterUri(file: TFile, field: ZoteroUriField): string | null {
    const uri = this.app.metadataCache.getFileCache(file)?.frontmatter?.[field];
    return typeof uri === "string" && uri.length > 0 ? uri : null;
  }

  private async getFrontmatterUriFromFile(file: TFile, field: ZoteroUriField): Promise<string | null> {
    const cached = this.getFrontmatterUri(file, field);
    if (cached) return cached;
    const markdown = await this.app.vault.cachedRead(file);
    return readFrontmatterString(markdown, field) ?? null;
  }

  private async findCitationPaperNote(entry: ZoteroCitationItem): Promise<TFile | null> {
    const keys = citationLookupKeys(entry);
    const papersRoot = normalizePath(`${this.settings.targetFolder}/${this.settings.papersFolderName}`);
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${papersRoot}/`));

    for (const file of files) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter && frontmatterMatchesCitation(frontmatter, keys)) return file;
    }

    for (const file of files) {
      const markdown = await this.app.vault.cachedRead(file);
      if (markdownFrontmatterMatchesCitation(markdown, keys)) return file;
    }

    console.warn("[local-zotero-mirror] Could not resolve local note for citation", {
      itemKey: entry.itemKey,
      citekey: entry.citekey,
      aliases: entry.citation.aliases ?? []
    });
    return null;
  }

  private getMarkdownFile(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile && file.extension === "md" ? file : null;
  }

  private getActiveMarkdownText(file: TFile): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path === file.path ? view.getViewData() : null;
  }

  private openZoteroUriFromFile(
    file: TFile | null,
    field: ZoteroUriField,
    messages: { noFileMessage?: string; missingLinkMessage: string }
  ): void {
    if (!file) {
      new Notice(messages.noFileMessage || "No note selected.");
      return;
    }

    const uri = this.getFrontmatterUri(file, field);
    if (!uri) {
      new Notice(messages.missingLinkMessage);
      return;
    }
    void openExternalUri(uri, messages.missingLinkMessage);
  }

  private registerConfiguredInterval(): void {
    const minutes = Number(this.settings.syncIntervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.registerInterval(
      window.setInterval(() => {
        void this.runSync({ dryRun: this.settings.dryRunPreview, silent: true });
      }, minutes * 60 * 1000)
    );
  }
}

function createCitationEditorExtension(plugin: ObsidianZoteroConnectorPlugin): Extension {
  const citationViewPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(private readonly view: EditorView) {
        plugin.registerEditorView(view);
        plugin.scheduleEditorCitationResolve(view);
        this.decorations = buildEditorCitationDecorations(view);
      }

      update(update: ViewUpdate): void {
        const sourceChanged = sourcePathFromState(update.startState) !== sourcePathFromState(update.state);
        if (update.docChanged || sourceChanged || livePreviewChanged(update)) {
          plugin.scheduleEditorCitationResolve(update.view);
        }

        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          livePreviewChanged(update) ||
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(citationRenderEffect))
          )
        ) {
          this.decorations = buildEditorCitationDecorations(update.view);
        }
      }

      destroy(): void {
        plugin.unregisterEditorView(this.view);
      }
    },
    {
      decorations: (value) => value.decorations
    }
  );

  return [citationDocumentStateField, citationViewPlugin];
}

function buildEditorCitationDecorations(view: EditorView): DecorationSet {
  if (!isLivePreview(view)) return Decoration.none;
  const sourcePath = sourcePathFromEditorView(view);
  const citationState = view.state.field(citationDocumentStateField, false);
  if (!sourcePath || citationState?.sourcePath !== sourcePath) return Decoration.none;

  const ranges = buildCitationRenderRanges(
    view.state.doc.toString(),
    citationState.response,
    view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to }))
  );
  return Decoration.set(
    ranges.map((range) =>
      Decoration.replace({
        widget: new CitationWidget(range.rendered, {
          citekeys: range.citekeys,
          missing: range.missing,
          source: range.source
        }),
        inclusive: false
      }).range(range.from, range.to)
    ),
    true
  );
}

class CitationWidget extends WidgetType {
  constructor(
    private readonly rendered: string,
    private readonly metadata: {
      citekeys: string[];
      missing: string[];
      source: ZoteroCitationResponse["source"] | "none";
    }
  ) {
    super();
  }

  eq(other: CitationWidget): boolean {
    return (
      this.rendered === other.rendered &&
      this.metadata.source === other.metadata.source &&
      this.metadata.citekeys.join(",") === other.metadata.citekeys.join(",") &&
      this.metadata.missing.join(",") === other.metadata.missing.join(",")
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `${CITATION_WIDGET_CLASS} local-zotero-citation`;
    if (this.metadata.missing.length > 0) {
      span.classList.add("is-missing");
    } else if (this.metadata.source !== "zotero") {
      span.classList.add("is-cached");
    }
    span.textContent = this.rendered;
    span.title = [
      `Zotero citation: ${this.metadata.citekeys.join(", ")}`,
      this.metadata.missing.length > 0 ? `Missing citekey: ${this.metadata.missing.join(", ")}` : "",
      this.metadata.source !== "zotero" && this.metadata.source !== "none"
        ? `Citation source: ${this.metadata.source}`
        : ""
    ]
      .filter(Boolean)
      .join("\n");
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class CurrentCitationsView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: ObsidianZoteroConnectorPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return CURRENT_CITATIONS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "当前引用的文献";
  }

  getIcon(): string {
    return "quote";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("local-zotero-current-citations");

    const heading = container.createEl("h3", { text: "当前引用的文献" });
    heading.addClass("local-zotero-current-citations-heading");

    let data: CurrentCitationsPanelData;
    try {
      data = await this.plugin.getCurrentCitationsPanelData();
    } catch (error) {
      container.createEl("p", {
        cls: "local-zotero-current-citations-status is-error",
        text: `引用读取失败：${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }

    if (!data.file) {
      container.createEl("p", {
        cls: "local-zotero-current-citations-status",
        text: "当前没有打开 Markdown 文件。"
      });
      return;
    }

    container.createEl("div", {
      cls: "local-zotero-current-citations-file",
      text: data.file.basename
    });

    if (!data.response || data.entries.length === 0) {
      const message = data.missingCitekeys.length > 0
        ? `缺失 citekey：${data.missingCitekeys.join(", ")}`
        : "当前文件没有引用文献。";
      container.createEl("p", {
        cls: data.missingCitekeys.length > 0
          ? "local-zotero-current-citations-status is-error"
          : "local-zotero-current-citations-status",
        text: message
      });
      return;
    }

    if (data.response.source && data.response.source !== "zotero") {
      container.createEl("p", {
        cls: "local-zotero-current-citations-status",
        text: `Citation source: ${data.response.source}`
      });
    }

    if (data.missingCitekeys.length > 0) {
      container.createEl("p", {
        cls: "local-zotero-current-citations-status is-error",
        text: `缺失 citekey：${data.missingCitekeys.join(", ")}`
      });
    }

    const list = container.createEl("div", { cls: "local-zotero-current-citations-list" });
    for (const entry of data.entries) {
      this.renderEntry(list, entry, data.sourcePath);
    }
  }

  private renderEntry(container: HTMLElement, entry: CurrentCitationPanelEntry, sourcePath: string): void {
    const item = container.createEl("article", { cls: "local-zotero-current-citation-item" });
    item.createEl("div", { cls: "local-zotero-current-citation-citekey", text: entry.citekey });
    item.createEl("div", { cls: "local-zotero-current-citation-title", text: entry.title });
    if (entry.apaReference) {
      item.createEl("p", { cls: "local-zotero-current-citation-reference", text: entry.apaReference });
    }

    const actions = item.createEl("div", { cls: "local-zotero-current-citation-actions" });
    this.addActionButton(actions, "Open note", citationActionState("note", entry), async () => {
      await this.openCitationNote(entry.notePath, sourcePath);
    });
    this.addActionButton(actions, "Zotero", citationActionState("zotero", entry), async () => {
      await openExternalUri(entry.zoteroUri, "缺少 Zotero 链接，无法打开条目。");
    });
    this.addActionButton(actions, "PDF", citationActionState("pdf", entry), async () => {
      await openExternalUri(entry.pdfUri, "缺少 PDF 链接，无法打开附件。");
    });
  }

  private async openCitationNote(notePath: string | undefined, sourcePath: string): Promise<void> {
    if (!notePath) {
      new Notice("尚未同步本地 note，无法打开。");
      return;
    }
    const normalizedPath = normalizePath(notePath);
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    try {
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf("tab").openFile(file);
      } else {
        await this.app.workspace.openLinkText(normalizedPath, sourcePath, true);
      }
    } catch (error) {
      new Notice(`打开本地 note 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private addActionButton(
    container: HTMLElement,
    label: string,
    state: CurrentCitationActionState,
    onClick: () => Promise<void>
  ): void {
    const button = container.createEl("button", {
      cls: "local-zotero-current-citation-action",
      text: label
    });
    button.type = "button";
    button.disabled = !state.enabled;
    button.title = state.title;
    if (state.target) button.dataset.target = state.target;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!state.enabled) {
        new Notice(state.title);
        return;
      }
      void onClick();
    });
  }
}


function citationLookupKeys(entry: ZoteroCitationItem): Set<string> {
  return new Set([
    entry.itemKey,
    entry.citekey,
    entry.citation.citekey,
    ...(entry.citation.aliases ?? [])
  ].filter((key): key is string => typeof key === "string" && key.length > 0));
}

function frontmatterMatchesCitation(frontmatter: Record<string, unknown>, keys: Set<string>): boolean {
  const candidates = [
    frontmatter.zotero_key,
    frontmatter.citekey,
    ...(Array.isArray(frontmatter.citation_aliases) ? frontmatter.citation_aliases : [])
  ];
  return candidates.some((candidate) => typeof candidate === "string" && keys.has(candidate));
}

function markdownFrontmatterMatchesCitation(markdown: string, keys: Set<string>): boolean {
  const candidates = [
    readFrontmatterString(markdown, "zotero_key"),
    readFrontmatterString(markdown, "citekey"),
    ...(readFrontmatterStringArray(markdown, "citation_aliases") ?? [])
  ];
  return candidates.some((candidate) => candidate && keys.has(candidate));
}

async function openExternalUri(uri: string | undefined, missingMessage: string): Promise<void> {
  if (!uri) {
    new Notice(missingMessage);
    return;
  }

  try {
    const electronShell = getElectronShell();
    if (electronShell) {
      await electronShell.openExternal(uri);
      return;
    }
    window.open(uri);
  } catch (error) {
    try {
      window.open(uri);
      return;
    } catch {
      // Report the original Electron error below when both routes fail.
    }
    new Notice(`打开外部链接失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function getElectronShell(): ElectronShell | null {
  try {
    const electron = require("electron") as { shell?: ElectronShell };
    return electron.shell ?? null;
  } catch {
    return null;
  }
}

function sourcePathFromEditorView(view: EditorView): string | null {
  return sourcePathFromState(view.state);
}

function sourcePathFromState(state: EditorState): string | null {
  try {
    return state.field(editorInfoField, false)?.file?.path ?? null;
  } catch {
    return null;
  }
}

function isLivePreview(view: EditorView): boolean {
  try {
    return Boolean(view.state.field(editorLivePreviewField, false));
  } catch {
    return false;
  }
}

function livePreviewChanged(update: ViewUpdate): boolean {
  try {
    return update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false);
  } catch {
    return false;
  }
}

class ObsidianNoteStore implements NoteStore {
  constructor(private readonly app: App) {}

  async listMarkdownFiles(rootPath: string): Promise<NoteRecord[]> {
    const root = normalizePath(rootPath);
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path === root || file.path.startsWith(`${root}/`));

    return Promise.all(
      files.map(async (file) => ({
        path: file.path,
        content: await this.app.vault.read(file)
      }))
    );
  }

  async read(path: string): Promise<string | null> {
    const file = this.getFile(path);
    return file ? this.app.vault.read(file) : null;
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const parts = normalized.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.getFile(normalized);
    if (file) {
      await this.app.vault.modify(file, content);
      return;
    }
    const folder = dirname(normalized);
    if (folder) {
      await this.ensureFolder(folder);
    }
    await this.app.vault.create(normalized, content);
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const file = this.getFile(fromPath);
    if (!file) return;
    await this.app.fileManager.renameFile(file, normalizePath(toPath));
  }

  private getFile(path: string): TFile | null {
    const entry = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return entry instanceof TFile ? entry : null;
  }
}

class ConnectorSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianZoteroConnectorPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Zotero bridge URL")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.bridgeUrl)
          .onChange(async (value) => {
            this.plugin.settings.bridgeUrl = value.trim() || DEFAULT_SETTINGS.bridgeUrl;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Target note folder")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (value) => {
            this.plugin.settings.targetFolder = value.trim() || DEFAULT_SETTINGS.targetFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval minutes")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.syncIntervalMinutes = Number.isFinite(parsed) ? parsed : 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Library scope")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("all", "All")
          .addOption("user", "User")
          .addOption("group", "Group")
          .setValue(this.plugin.settings.libraryScope)
          .onChange(async (value) => {
            this.plugin.settings.libraryScope = value as LibraryScope;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Filename template")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.filenameTemplate)
          .onChange(async (value) => {
            this.plugin.settings.filenameTemplate = value.trim() || DEFAULT_SETTINGS.filenameTemplate;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Preview scheduled syncs")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.dryRunPreview)
          .onChange(async (value) => {
            this.plugin.settings.dryRunPreview = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Missing Zotero items")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("mark", "Mark")
          .addOption("archive", "Archive")
          .addOption("ignore", "Ignore")
          .setValue(this.plugin.settings.deleteBehavior)
          .onChange(async (value) => {
            this.plugin.settings.deleteBehavior = value as DeleteBehavior;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bridge status")
      .addButton((button) =>
        button.setButtonText("Check").onClick(async () => {
          try {
            const status = await this.plugin.fetchStatus();
            new Notice(status.ok ? "Zotero bridge is reachable." : "Zotero bridge returned a warning.");
          } catch (error) {
            new Notice(`Zotero bridge check failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        })
      );
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function stripOuterParens(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("(") && trimmed.endsWith(")") ? trimmed.slice(1, -1).trim() : trimmed;
}

async function fetchBridgeJson<T>(url: string): Promise<T> {
  const errors: string[] = [];
  for (const candidate of bridgeUrlCandidates(url)) {
    if (isLocalBridgeUrl(candidate)) {
      try {
        return (await requestJsonWithNode(candidate)) as T;
      } catch (error) {
        errors.push(`node ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const response = await requestUrl({
        method: "GET",
        url: candidate,
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache"
        }
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json as T;
    } catch (error) {
      errors.push(`requestUrl ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(errors.join("; "));
}

async function postBridgeJson<T>(url: string, payload: unknown): Promise<T> {
  const errors: string[] = [];
  const body = JSON.stringify(payload);
  for (const candidate of bridgeUrlCandidates(url)) {
    if (isLocalBridgeUrl(candidate)) {
      try {
        return (await requestJsonWithNode(candidate, { method: "POST", body })) as T;
      } catch (error) {
        errors.push(`node ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const response = await requestUrl({
        method: "POST",
        url: candidate,
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          "Content-Type": "application/json"
        },
        body
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json as T;
    } catch (error) {
      errors.push(`requestUrl ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(errors.join("; "));
}

function bridgeUrlCandidates(url: string): string[] {
  const candidates = [url];
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      candidates.push(parsed.toString());
    } else if (parsed.hostname === "127.0.0.1") {
      parsed.hostname = "localhost";
      candidates.push(parsed.toString());
    }
  } catch {
    // Keep the original URL error for the caller.
  }
  return [...new Set(candidates)];
}

function isLocalBridgeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function requestJsonWithNode(
  url: string,
  options: { method?: "GET" | "POST"; body?: string } = {}
): Promise<unknown> {
  const parsed = new URL(url);
  const requester = require(parsed.protocol === "https:" ? "https" : "http") as typeof import("http");
  const method = options.method || "GET";
  const headers: Record<string, string | number> = {
    Accept: "application/json"
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(options.body);
  }

  return new Promise((resolve, reject) => {
    const request = requester.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        family: parsed.hostname === "localhost" ? 4 : undefined,
        headers,
        timeout: 30000
      },
      (response) => {
        let body = "";
        let settled = false;
        const finish = (value: unknown) => {
          if (settled) return;
          settled = true;
          resolve(value);
          request.destroy();
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) return;
          const parsed = tryParseJson(body);
          if (parsed.ok) {
            finish(parsed.value);
          }
        });
        response.on("end", () => {
          if (settled) return;
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            fail(new Error(`HTTP ${status}`));
            return;
          }
          const parsed = tryParseJson(body);
          if (parsed.ok) {
            finish(parsed.value);
          } else {
            fail(new Error(`Invalid JSON response: ${parsed.error}`));
          }
        });
      }
    );

    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Request timed out")));
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

function tryParseJson(value: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
