import assert from "node:assert/strict";
import test from "node:test";
import {
  BIBTEX_EXPORT_MARKER,
  buildBibtexExportFile,
  formatApaReferenceList,
  formatBibtexEntries,
  type ZoteroCitationResponse
} from "../packages/shared/src/index.ts";

test("formatApaReferenceList deduplicates references and keeps missing warnings", () => {
  const result = formatApaReferenceList({
    ...citationResponse(),
    bibliography: ["Smith, A. (2024). Paper.", "Chen, B. (2025). Study.", "Smith, A. (2024). Paper."],
    missingCitekeys: ["missing2026"]
  });

  assert.equal(result.text, "Smith, A. (2024). Paper.\n\nChen, B. (2025). Study.\n");
  assert.equal(result.count, 2);
  assert.deepEqual(result.missingCitekeys, ["missing2026"]);
  assert.match(result.warnings.join("\n"), /missing2026/);
});

test("formatBibtexEntries deduplicates entries and reports skipped citekeys", () => {
  const result = formatBibtexEntries({
    ...citationResponse(),
    entries: [
      citationItem("I1", "smith2024", "@article{smith2024,\n  title = {Paper}\n}"),
      citationItem("I1", "smith2024Alias", "@article{smith2024,\n  title = {Paper}\n}"),
      citationItem("I2", "chen2025", undefined)
    ]
  });

  assert.equal(result.text, "@article{smith2024,\n  title = {Paper}\n}\n");
  assert.equal(result.count, 1);
  assert.deepEqual(result.skippedCitekeys, ["chen2025"]);
  assert.match(result.warnings.join("\n"), /缺少 BibTeX：chen2025/);
});

test("buildBibtexExportFile adds a stable generated-file marker", () => {
  const result = buildBibtexExportFile({
    sourcePath: "Reviews/2026-06-05.md",
    generatedAt: "2026-06-05T03:00:00.000Z",
    response: {
      ...citationResponse(),
      entries: [citationItem("I1", "smith2024", "@article{smith2024,\n  title = {Paper}\n}")]
    }
  });

  assert.match(result.text, new RegExp(`^${escapeRegExp(BIBTEX_EXPORT_MARKER)}`));
  assert.match(result.text, /% Source: Reviews\/2026-06-05\.md/);
  assert.match(result.text, /% Generated at: 2026-06-05T03:00:00\.000Z/);
  assert.match(result.text, /@article\{smith2024,/);
});

function citationResponse(): ZoteroCitationResponse {
  return {
    ok: true,
    schemaVersion: 1,
    style: "apa",
    generatedAt: "2026-06-05T00:00:00.000Z",
    groups: [],
    bibliography: [],
    entries: [],
    missingCitekeys: [],
    source: "zotero"
  };
}

function citationItem(itemKey: string, citekey: string, bibtex: string | undefined) {
  return {
    itemKey,
    citekey,
    title: citekey,
    citation: {
      citekey,
      apaReference: `${citekey} reference`,
      bibtex
    }
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
