import assert from "node:assert/strict";
import test from "node:test";
import { mergeManagedFrontmatter, readFrontmatterString } from "../packages/shared/src/index.ts";

test("mergeManagedFrontmatter preserves user fields and body", () => {
  const original = [
    "---",
    "status: reading",
    'zotero_key: "OLD"',
    "aliases:",
    '  - "custom alias"',
    "---",
    "",
    "## Summary",
    "My own note."
  ].join("\n");

  const merged = mergeManagedFrontmatter(original, {
    zotero_key: "NEW",
    title: "Updated title",
    tags: ["zotero", "paper"],
    zotero_deleted: false
  });

  assert.match(merged, /status: reading/);
  assert.match(merged, /aliases:\n  - "custom alias"/);
  assert.match(merged, /zotero_key: "NEW"/);
  assert.doesNotMatch(merged, /zotero_key: "OLD"/);
  assert.match(merged, /## Summary\nMy own note\./);
  assert.equal(readFrontmatterString(merged, "zotero_key"), "NEW");
});
