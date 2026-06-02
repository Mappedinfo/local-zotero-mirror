import assert from "node:assert/strict";
import test from "node:test";
import { ensureUniquePath, makePaperFileName, sanitizePathSegment } from "../packages/shared/src/index.ts";
import type { ZoteroItem } from "../packages/shared/src/index.ts";

test("sanitizePathSegment removes invalid path characters", () => {
  assert.equal(sanitizePathSegment(' A/B:C*D? "paper"  '), "A B C D paper");
  assert.equal(sanitizePathSegment("   "), "Untitled");
});

test("makePaperFileName renders stable item tokens", () => {
  const item: ZoteroItem = {
    key: "ABCD1234",
    library: { id: 1, type: "user" },
    citekey: "smithUseful2024",
    title: "Useful / Dangerous: A Paper?",
    creators: [{ firstName: "Ada", lastName: "Smith", creatorType: "author" }],
    year: "2024",
    itemType: "journalArticle",
    collectionKeys: [],
    tags: [],
    attachments: []
  };

  assert.equal(
    makePaperFileName(item, "{year} - {firstAuthor} - {title}"),
    "2024 - Smith - Useful Dangerous A Paper.md"
  );
});

test("ensureUniquePath accounts for case-insensitive filesystem collisions", () => {
  const used = new Set<string>();

  assert.equal(ensureUniquePath("Zotero/Papers/Paper.md", used), "Zotero/Papers/Paper.md");
  assert.equal(ensureUniquePath("Zotero/Papers/paper.md", used), "Zotero/Papers/paper 2.md");
});
