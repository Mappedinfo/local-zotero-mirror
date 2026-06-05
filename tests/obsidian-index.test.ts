import assert from "node:assert/strict";
import test from "node:test";
import { buildObsidianIndexFromNotes, DEFAULT_SYNC_SETTINGS, type NoteRecord } from "../packages/shared/src/index.ts";

test("buildObsidianIndexFromNotes rebuilds a citation index from synced paper notes", () => {
  const records: NoteRecord[] = [{
    path: "Zotero/Papers/2026 - Unknown - In Dakar.md",
    content: `---
zotero_key: "GJWEZCYB"
citekey: "DakarCulturalCenter2026"
citation_aliases:
  - "GJWEZCYB"
citekey_source: "generated"
citation_apa: "(Dakar, 2026)"
reference_apa: "Dakar reference"
bibtex: "@article{DakarCulturalCenter2026}"
title: "In Dakar"
zotero_uri: "zotero://select/library/items/GJWEZCYB"
pdf_uri: "zotero://select/library/items/5DHF6GAM"
last_synced: "2026-06-05T00:00:00.000Z"
---
Body
`
  }];

  const index = buildObsidianIndexFromNotes(records, DEFAULT_SYNC_SETTINGS, "2026-06-05T01:00:00.000Z");
  assert.equal(index?.items.GJWEZCYB.path, "Zotero/Papers/2026 - Unknown - In Dakar.md");
  assert.equal(index?.items.GJWEZCYB.citekey, "DakarCulturalCenter2026");
  assert.equal(index?.items.GJWEZCYB.zoteroUri, "zotero://select/library/items/GJWEZCYB");
  assert.deepEqual(index?.items.GJWEZCYB.citation?.aliases, ["GJWEZCYB"]);
  assert.equal(index?.items.GJWEZCYB.citation?.apaReference, "Dakar reference");
});

test("buildObsidianIndexFromNotes returns null when no synced Zotero notes exist", () => {
  const index = buildObsidianIndexFromNotes([
    { path: "Notes/plain.md", content: "No Zotero frontmatter" }
  ], DEFAULT_SYNC_SETTINGS, "2026-06-05T01:00:00.000Z");
  assert.equal(index, null);
});
