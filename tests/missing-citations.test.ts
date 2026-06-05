import assert from "node:assert/strict";
import test from "node:test";
import { missingCitekeyGuidance, missingCitekeySummary } from "../packages/shared/src/index.ts";

test("missingCitekeyGuidance tells users how to recover", () => {
  const guidance = missingCitekeyGuidance(["zhangMultiObjectiveOptimizationMethod2024"], "zotero");
  assert.equal(missingCitekeySummary(["a", "b"]), "缺失 citekey：a, b");
  assert.match(guidance, /Sync Zotero Library/);
  assert.match(guidance, /Better BibTeX/);
  assert.match(guidance, /Citation Key/);
});
