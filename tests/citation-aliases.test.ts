import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCitekeyAliasRegistry,
  rewriteMapFromRegistry,
  rewritePandocCitekeys,
  type ZoteroBridgeSnapshot,
  type ZoteroObsidianIndex
} from "../packages/shared/src/index.ts";

test("buildCitekeyAliasRegistry preserves historical citekeys for the same Zotero item", () => {
  const snapshot: ZoteroBridgeSnapshot = {
    schemaVersion: 3,
    generatedAt: "2026-06-07T00:00:00.000Z",
    library: { id: 1, type: "user" },
    collections: [],
    items: [
      {
        key: "CGXJTT32",
        library: { id: 1, type: "user" },
        citekey:
          "ZhongHuaRenMinGongHeGuoZhuFangHeChengXiangJianSheBuJianSheXiangMuJiaoTongYingXiangPingJieJiShuBiaoZhun2010",
        citation: {
          citekey:
            "ZhongHuaRenMinGongHeGuoZhuFangHeChengXiangJianSheBuJianSheXiangMuJiaoTongYingXiangPingJieJiShuBiaoZhun2010",
          aliases: ["CGXJTT32"],
          citekeySource: "generated"
        },
        title: "建设项目交通影响评价技术标准",
        creators: [],
        year: "2010",
        itemType: "standard",
        collectionKeys: [],
        tags: [],
        attachments: []
      }
    ]
  };
  const previousIndex: ZoteroObsidianIndex = {
    schemaVersion: 1,
    generatedAt: "2026-06-06T00:00:00.000Z",
    targetFolder: "Zotero",
    papersFolderName: "Papers",
    standaloneNotesFolderName: "Notes",
    items: {
      CGXJTT32: {
        itemKey: "CGXJTT32",
        path: "Zotero/Papers/2010.md",
        title: "建设项目交通影响评价技术标准",
        citekey: "2010",
        citation: { citekey: "2010", aliases: ["CGXJTT32"], citekeySource: "generated" },
        nativeNoteCount: 0,
        lastSynced: "2026-06-06T00:00:00.000Z"
      }
    },
    standaloneNotes: {}
  };

  const registry = buildCitekeyAliasRegistry(snapshot, previousIndex, null, "2026-06-07T00:00:00.000Z");

  assert.equal(
    registry.aliases["2010"].currentCitekey,
    "ZhongHuaRenMinGongHeGuoZhuFangHeChengXiangJianSheBuJianSheXiangMuJiaoTongYingXiangPingJieJiShuBiaoZhun2010"
  );
  assert.equal(registry.aliases.CGXJTT32.itemKey, "CGXJTT32");
});

test("rewritePandocCitekeys rewrites only parsed Pandoc citations", () => {
  const registry = {
    schemaVersion: 1 as const,
    generatedAt: "2026-06-07T00:00:00.000Z",
    aliases: {
      oldKey2026: {
        alias: "oldKey2026",
        itemKey: "I1",
        currentCitekey: "newKey2026",
        source: "confirmed" as const,
        updatedAt: "2026-06-07T00:00:00.000Z"
      }
    }
  };
  const markdown = [
    "Use [@oldKey2026; @other2025].",
    "",
    "`[@oldKey2026]`",
    "",
    "```",
    "[@oldKey2026]",
    "```"
  ].join("\n");

  const result = rewritePandocCitekeys(markdown, rewriteMapFromRegistry(registry));

  assert.match(result.markdown, /Use \[@newKey2026; @other2025\]\./);
  assert.match(result.markdown, /`\[@oldKey2026\]`/);
  assert.match(result.markdown, /```\n\[@oldKey2026\]\n```/);
  assert.equal(result.replacements, 1);
});
