import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCitationRenderRanges,
  findPandocCitationGroups,
  parsePandocCitationMarkup,
  uniqueCitationGroups,
  type ZoteroCitationResponse
} from "../packages/shared/src/index.ts";

test("parsePandocCitationMarkup extracts single and grouped citekeys", () => {
  assert.deepEqual(parsePandocCitationMarkup("@smith2024"), ["smith2024"]);
  assert.deepEqual(parsePandocCitationMarkup("@smith2024; see also @chen_2023:urban"), [
    "smith2024",
    "chen_2023:urban"
  ]);
});

test("findPandocCitationGroups ignores inline code, fenced code, and ordinary links", () => {
  const markdown = [
    "Useful claim [@smith2024; @chen2023].",
    "",
    "`[@ignoredInline2022]`",
    "",
    "[profile](https://example.com/@not-a-citation)",
    "",
    "```",
    "[@ignoredFence2021]",
    "```",
    "",
    "Another claim [@wang-2025]."
  ].join("\n");

  const groups = findPandocCitationGroups(markdown);
  assert.deepEqual(
    groups.map((group) => group.citekeys),
    [["smith2024", "chen2023"], ["wang-2025"]]
  );
  assert.deepEqual(uniqueCitationGroups(groups), [["smith2024", "chen2023"], ["wang-2025"]]);
});

test("buildCitationRenderRanges maps citekeys to rendered editor ranges", () => {
  const markdown = "Useful claim [@smith2024; @chen2023].";
  const response = citationResponse([["smith2024", "chen2023"]], ["(Smith, 2024; Chen, 2023)"]);
  const ranges = buildCitationRenderRanges(markdown, response);

  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges[0].citekeys, ["smith2024", "chen2023"]);
  assert.equal(ranges[0].raw, "[@smith2024; @chen2023]");
  assert.equal(ranges[0].rendered, "(Smith, 2024; Chen, 2023)");
  assert.deepEqual(ranges[0].missing, []);
});

test("buildCitationRenderRanges hides ranges under the cursor and reports missing citekeys", () => {
  const markdown = "A [@missing2026] and B [@smith2024].";
  const ranges = buildCitationRenderRanges(markdown, citationResponse([["smith2024"]], ["(Smith, 2024)"]), [
    { from: 2, to: 16 }
  ]);

  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges[0].citekeys, ["smith2024"]);
  assert.equal(ranges[0].rendered, "(Smith, 2024)");

  const missing = buildCitationRenderRanges(markdown, null);
  assert.equal(missing[0].rendered, "[missing: missing2026]");
  assert.deepEqual(missing[0].missing, ["missing2026"]);
  assert.equal(missing[0].source, "none");
});

test("buildCitationRenderRanges hides a citation when the cursor is inside it", () => {
  const markdown = "A [@smith2024].";
  const ranges = buildCitationRenderRanges(markdown, citationResponse([["smith2024"]], ["(Smith, 2024)"]), [
    { from: 5, to: 5 }
  ]);

  assert.deepEqual(ranges, []);
});

function citationResponse(groups: string[][], rendered: string[]): ZoteroCitationResponse {
  return {
    ok: true,
    schemaVersion: 1,
    style: "apa",
    generatedAt: "2026-06-05T00:00:00.000Z",
    groups: groups.map((citekeys, index) => ({
      citekeys,
      rendered: rendered[index],
      missing: [],
      items: []
    })),
    bibliography: [],
    entries: [],
    missingCitekeys: [],
    source: "zotero"
  };
}
