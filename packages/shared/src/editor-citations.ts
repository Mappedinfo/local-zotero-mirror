import { citationGroupKey, findPandocCitationGroups } from "./citations.ts";
import type { ZoteroCitationResponse } from "./types.ts";

export interface TextRange {
  from: number;
  to: number;
}

export interface CitationRenderRange {
  from: number;
  to: number;
  raw: string;
  citekeys: string[];
  rendered: string;
  missing: string[];
  source: ZoteroCitationResponse["source"] | "none";
}

export function buildCitationRenderRanges(
  markdown: string,
  response: ZoteroCitationResponse | null,
  hiddenRanges: TextRange[] = []
): CitationRenderRange[] {
  const groups = findPandocCitationGroups(markdown);
  const responseGroups = new Map(response?.groups.map((group) => [citationGroupKey(group.citekeys), group]) ?? []);
  const source = response?.source ?? "none";

  return groups
    .filter((group) => !hiddenRanges.some((range) => rangesOverlap(group.start, group.end, range.from, range.to)))
    .map((group) => {
      const rendered = responseGroups.get(citationGroupKey(group.citekeys));
      const missing = rendered?.missing ?? group.citekeys;
      return {
        from: group.start,
        to: group.end,
        raw: group.raw,
        citekeys: group.citekeys,
        rendered: rendered?.rendered || `[missing: ${group.citekeys.join(", ")}]`,
        missing,
        source
      };
    });
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  if (startB === endB) return startA <= startB && startB <= endA;
  return startA < endB && startB < endA;
}
