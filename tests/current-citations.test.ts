import assert from "node:assert/strict";
import test from "node:test";
import {
  citationActionState,
  findObsidianIndexItemForCitation,
  type ZoteroCitationItem,
  type ZoteroObsidianIndex
} from "../packages/shared/src/index.ts";

test("findObsidianIndexItemForCitation resolves by itemKey", () => {
  const index = indexFixture();
  const item = findObsidianIndexItemForCitation(citationItem({ itemKey: "GJWEZCYB" }), index);
  assert.equal(item?.path, "Zotero/Papers/Dakar.md");
});

test("findObsidianIndexItemForCitation falls back to citekey and aliases", () => {
  const index = indexFixture();
  const byCitekey = findObsidianIndexItemForCitation(citationItem({ itemKey: "NEWKEY" }), index);
  const byAlias = findObsidianIndexItemForCitation(
    citationItem({ itemKey: "NEWKEY", citekey: "UnseenKey", aliases: ["GJWEZCYB"] }),
    index
  );
  assert.equal(byCitekey?.itemKey, "GJWEZCYB");
  assert.equal(byAlias?.itemKey, "GJWEZCYB");
});

test("citationActionState exposes enabled targets and disabled reasons", () => {
  assert.deepEqual(citationActionState("note", { notePath: "Zotero/Papers/Dakar.md" }), {
    kind: "note",
    enabled: true,
    target: "Zotero/Papers/Dakar.md",
    title: "打开本地 note：Zotero/Papers/Dakar.md"
  });
  assert.equal(citationActionState("zotero", { zoteroUri: "zotero://select/library/items/GJWEZCYB" }).enabled, true);
  assert.equal(citationActionState("pdf", {}).enabled, false);
  assert.match(citationActionState("pdf", {}).title, /缺少 PDF 链接/);
});

function citationItem(args: { itemKey: string; citekey?: string; aliases?: string[] }): ZoteroCitationItem {
  return {
    itemKey: args.itemKey,
    citekey: args.citekey ?? "DakarCulturalCenter2026",
    title: "In Dakar, a cultural center grows around a baobab tree",
    citation: {
      citekey: args.citekey ?? "DakarCulturalCenter2026",
      aliases: args.aliases ?? ["GJWEZCYB"],
      apaReference: "Dakar reference"
    }
  };
}

function indexFixture(): ZoteroObsidianIndex {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-05T00:00:00.000Z",
    targetFolder: "Zotero",
    papersFolderName: "Papers",
    standaloneNotesFolderName: "Notes",
    standaloneNotes: {},
    items: {
      GJWEZCYB: {
        itemKey: "GJWEZCYB",
        path: "Zotero/Papers/Dakar.md",
        title: "In Dakar, a cultural center grows around a baobab tree",
        citekey: "DakarCulturalCenter2026",
        zoteroUri: "zotero://select/library/items/GJWEZCYB",
        nativeNoteCount: 0,
        lastSynced: "2026-06-05T00:00:00.000Z",
        citation: {
          citekey: "DakarCulturalCenter2026",
          aliases: ["GJWEZCYB"]
        }
      }
    }
  };
}
