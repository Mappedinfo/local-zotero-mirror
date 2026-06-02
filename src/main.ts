import {
  App,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl
} from "obsidian";
import {
  DEFAULT_SYNC_SETTINGS,
  assertZoteroSnapshot,
  dirname,
  syncSnapshotToStore,
  type DeleteBehavior,
  type LibraryScope,
  type NoteRecord,
  type NoteStore,
  type SyncSettings,
  type ZoteroBridgeSnapshot,
  type ZoteroBridgeStatus
} from "../packages/shared/src/index.ts";

type ZoteroUriField = "zotero_uri" | "pdf_uri";

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

export default class ObsidianZoteroConnectorPlugin extends Plugin {
  settings: ConnectorSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ConnectorSettingTab(this.app, this));

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

    this.registerContextMenus();
    this.registerConfiguredInterval();
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
    window.open(uri);
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

async function requestJsonWithNode(url: string): Promise<unknown> {
  const parsed = new URL(url);
  const requester = require(parsed.protocol === "https:" ? "https" : "http") as typeof import("http");

  return new Promise((resolve, reject) => {
    const request = requester.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        family: parsed.hostname === "localhost" ? 4 : undefined,
        headers: {
          Accept: "application/json"
        },
        timeout: 30000
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      }
    );

    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Request timed out")));
    request.end();
  });
}
