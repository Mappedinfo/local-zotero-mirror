import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SYNC_SETTINGS,
  OBSIDIAN_ZOTERO_INDEX_FILE_NAME,
  htmlToMarkdown,
  syncSnapshotToStore,
  type NoteRecord,
  type NoteStore,
  type ZoteroBridgeSnapshot
} from "../packages/shared/src/index.ts";

class MemoryStore implements NoteStore {
  files = new Map<string, string>();

  async listMarkdownFiles(rootPath: string): Promise<NoteRecord[]> {
    return [...this.files.entries()]
      .filter(([path]) => path.endsWith(".md") && (path === rootPath || path.startsWith(`${rootPath}/`)))
      .map(([path, content]) => ({ path, content }));
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async ensureFolder(): Promise<void> {}

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const content = this.files.get(fromPath);
    if (content === undefined) return;
    this.files.delete(fromPath);
    this.files.set(toPath, content);
  }
}

test("syncSnapshotToStore creates canonical paper notes and collection indexes", async () => {
  const store = new MemoryStore();
  const result = await syncSnapshotToStore(snapshotFixture(), store, DEFAULT_SYNC_SETTINGS, {
    now: "2026-06-02T00:00:00.000Z"
  });

  assert.equal(result.created, 2);
  assert.equal(result.indexesWritten, 2);
  assert.equal(result.obsidianIndexWritten, 1);

  const paperPaths = [...store.files.keys()].filter((path) => path.includes("/Papers/"));
  assert.equal(paperPaths.length, 2);
  assert.ok(paperPaths.some((path) => path.includes("2024 - Smith - Multi Collection Paper.md")));
  assert.ok(store.files.has("Zotero/Collections/Planning.md"));
  assert.ok(store.files.has("Zotero/Collections/Planning/Scenario Assessment.md"));

  const parentIndex = store.files.get("Zotero/Collections/Planning.md")!;
  const childIndex = store.files.get("Zotero/Collections/Planning/Scenario Assessment.md")!;
  assert.match(parentIndex, /\[\[Zotero\/Papers\/2024 - Smith - Multi Collection Paper\|Multi Collection Paper\]\]/);
  assert.match(childIndex, /\[\[Zotero\/Papers\/2024 - Smith - Multi Collection Paper\|Multi Collection Paper\]\]/);

  const obsidianIndex = JSON.parse(store.files.get(`Zotero/${OBSIDIAN_ZOTERO_INDEX_FILE_NAME}`)!);
  assert.equal(obsidianIndex.items.I1.path, "Zotero/Papers/2024 - Smith - Multi Collection Paper.md");
});

test("syncSnapshotToStore preserves user note sections on repeat sync", async () => {
  const store = new MemoryStore();
  await syncSnapshotToStore(snapshotFixture(), store, DEFAULT_SYNC_SETTINGS, {
    now: "2026-06-02T00:00:00.000Z"
  });

  const path = "Zotero/Papers/2024 - Smith - Multi Collection Paper.md";
  store.files.set(path, `${store.files.get(path)!}\nMy long hand-written note.\n`);

  const result = await syncSnapshotToStore(snapshotFixture({ title: "Multi Collection Paper Revised" }), store, DEFAULT_SYNC_SETTINGS, {
    now: "2026-06-03T00:00:00.000Z"
  });

  assert.equal(result.updated, 2);
  assert.match(store.files.get(path)!, /title: "Multi Collection Paper Revised"/);
  assert.match(store.files.get(path)!, /My long hand-written note\./);
});

test("syncSnapshotToStore marks missing Zotero items without deleting notes", async () => {
  const store = new MemoryStore();
  await syncSnapshotToStore(snapshotFixture(), store, DEFAULT_SYNC_SETTINGS, {
    now: "2026-06-02T00:00:00.000Z"
  });

  const result = await syncSnapshotToStore(
    {
      ...snapshotFixture(),
      items: snapshotFixture().items.slice(0, 1)
    },
    store,
    DEFAULT_SYNC_SETTINGS,
    { now: "2026-06-04T00:00:00.000Z" }
  );

  assert.equal(result.deletedMarked, 1);
  const deletedNote = store.files.get("Zotero/Papers/2023 - Chen - Second Paper.md")!;
  assert.match(deletedNote, /zotero_deleted: true/);
  assert.match(deletedNote, /Status: missing from latest Zotero snapshot/);
});

test("htmlToMarkdown converts Zotero native note HTML into readable markdown", () => {
  assert.equal(
    htmlToMarkdown(
      '<div class="zotero-note znv1"><p>A <strong>useful</strong> point<br><a href="https://example.com">source</a></p><ul><li>one</li><li>two</li></ul></div>'
    ),
    "A **useful** point\n[source](https://example.com)\n\n- one\n- two\n"
  );
});

test("syncSnapshotToStore writes child Zotero native notes into a managed paper block", async () => {
  const store = new MemoryStore();
  await syncSnapshotToStore(snapshotFixtureWithNativeNotes(), store, DEFAULT_SYNC_SETTINGS, {
    now: "2026-06-02T00:00:00.000Z"
  });

  const path = "Zotero/Papers/2024 - Smith - Multi Collection Paper.md";
  const original = store.files.get(path)!;
  assert.match(original, /zotero_native_note_count: 1/);
  assert.match(original, /# zotero原生笔记迁移/);
  assert.match(original, /## Important annotation/);
  assert.match(original, /A \*\*strong\*\* Zotero note/);

  store.files.set(path, `${original}\nOutside marker stays mine.\n`);
  await syncSnapshotToStore(snapshotFixtureWithNativeNotes({ noteHtml: "<p>Updated Zotero note</p>" }), store, DEFAULT_SYNC_SETTINGS, {
    now: "2026-06-03T00:00:00.000Z"
  });

  const updated = store.files.get(path)!;
  assert.match(updated, /Updated Zotero note/);
  assert.doesNotMatch(updated, /A \*\*strong\*\* Zotero note/);
  assert.match(updated, /Outside marker stays mine\./);
});

test("syncSnapshotToStore creates standalone native note files and marks missing notes", async () => {
  const store = new MemoryStore();
  await syncSnapshotToStore(snapshotFixtureWithNativeNotes(), store, DEFAULT_SYNC_SETTINGS, {
    now: "2026-06-02T00:00:00.000Z"
  });

  const standalonePath = "Zotero/Zotero原生独立笔记/Standalone thought - N2.md";
  assert.ok(store.files.has(standalonePath));
  assert.match(store.files.get(standalonePath)!, /zotero_note_key: "N2"/);
  assert.match(store.files.get(standalonePath)!, /zotero_parent_key: null/);
  assert.match(store.files.get(standalonePath)!, /Standalone Zotero note/);

  const result = await syncSnapshotToStore(
    {
      ...snapshotFixtureWithNativeNotes(),
      nativeNotes: snapshotFixtureWithNativeNotes().nativeNotes!.filter((note) => note.key !== "N2")
    },
    store,
    DEFAULT_SYNC_SETTINGS,
    { now: "2026-06-04T00:00:00.000Z" }
  );

  assert.equal(result.standaloneNotesDeletedMarked, 1);
  assert.match(store.files.get(standalonePath)!, /zotero_note_deleted: true/);
});

function snapshotFixture(overrides: { title?: string } = {}): ZoteroBridgeSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-02T00:00:00.000Z",
    library: { id: 1, type: "user" },
    collections: [
      {
        key: "C1",
        name: "Planning",
        path: ["Planning"],
        itemKeys: ["I1"]
      },
      {
        key: "C2",
        name: "Scenario Assessment",
        parentKey: "C1",
        path: ["Planning", "Scenario Assessment"],
        itemKeys: ["I1", "I2"]
      }
    ],
    items: [
      {
        key: "I1",
        library: { id: 1, type: "user" },
        citekey: "smithMulti2024",
        title: overrides.title || "Multi Collection Paper",
        creators: [{ firstName: "Ada", lastName: "Smith", creatorType: "author" }],
        year: "2024",
        itemType: "journalArticle",
        publicationTitle: "Journal of Tests",
        doi: "10.0000/example",
        collectionKeys: ["C1", "C2"],
        tags: ["planning"],
        zoteroUri: "zotero://select/library/items/I1",
        attachments: [{ key: "A1", mimeType: "application/pdf", zoteroUri: "zotero://select/library/items/A1" }],
        version: 12
      },
      {
        key: "I2",
        library: { id: 1, type: "user" },
        title: "Second Paper",
        creators: [{ firstName: "Bo", lastName: "Chen", creatorType: "author" }],
        year: "2023",
        itemType: "conferencePaper",
        collectionKeys: ["C2"],
        tags: [],
        attachments: [],
        version: 4
      }
    ]
  };
}

function snapshotFixtureWithNativeNotes(overrides: { noteHtml?: string } = {}): ZoteroBridgeSnapshot {
  return {
    ...snapshotFixture(),
    schemaVersion: 2,
    nativeNotes: [
      {
        key: "N1",
        library: { id: 1, type: "user" },
        parentItemKey: "I1",
        title: "Important annotation",
        noteHtml: overrides.noteHtml || "<p>A <strong>strong</strong> Zotero note</p>",
        zoteroUri: "zotero://select/library/items/N1",
        version: 3,
        dateModified: "2026-06-01 12:00:00"
      },
      {
        key: "N2",
        library: { id: 1, type: "user" },
        title: "Standalone thought",
        noteHtml: "<p>Standalone Zotero note</p>",
        zoteroUri: "zotero://select/library/items/N2",
        version: 4,
        dateModified: "2026-06-01 13:00:00"
      }
    ]
  };
}
