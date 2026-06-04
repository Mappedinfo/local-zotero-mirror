import assert from "node:assert/strict";
import test from "node:test";
import {
  findPandocCitationGroups,
  parsePandocCitationMarkup,
  uniqueCitationGroups
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
