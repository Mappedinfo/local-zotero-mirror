export interface PandocCitationGroup {
  raw: string;
  citekeys: string[];
  start: number;
  end: number;
}

const PANDOC_CITATION_RE = /\[((?:[^\]\n]*@[-A-Za-z0-9_:.]+[^\]\n]*)+)\]/g;
const CITEKEY_RE = /@([-A-Za-z0-9_:.]+)/g;

export function parsePandocCitationMarkup(markup: string): string[] {
  const citekeys: string[] = [];
  const seen = new Set<string>();
  for (const segment of markup.split(";")) {
    CITEKEY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITEKEY_RE.exec(segment)) !== null) {
      const citekey = match[1].trim();
      if (!citekey || seen.has(citekey)) continue;
      seen.add(citekey);
      citekeys.push(citekey);
    }
  }
  return citekeys;
}

export function findPandocCitationGroups(markdown: string): PandocCitationGroup[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const groups: PandocCitationGroup[] = [];
  let offset = 0;
  let fenced = false;
  let fenceMarker = "";

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fenced) {
        fenced = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        fenced = false;
        fenceMarker = "";
      }
      offset += line.length + 1;
      continue;
    }

    if (!fenced) {
      const masked = maskInlineCode(line);
      PANDOC_CITATION_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PANDOC_CITATION_RE.exec(masked)) !== null) {
        const citekeys = parsePandocCitationMarkup(match[1]);
        if (citekeys.length === 0) continue;
        groups.push({
          raw: line.slice(match.index, match.index + match[0].length),
          citekeys,
          start: offset + match.index,
          end: offset + match.index + match[0].length
        });
      }
    }

    offset += line.length + 1;
  }

  return groups;
}

export function uniqueCitationGroups(groups: PandocCitationGroup[]): string[][] {
  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const group of groups) {
    const key = citationGroupKey(group.citekeys);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(group.citekeys);
  }
  return unique;
}

export function citationGroupKey(citekeys: string[]): string {
  return citekeys.join(",");
}

function maskInlineCode(line: string): string {
  let output = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      output += line[index];
      index += 1;
      continue;
    }

    const tickEnd = readBacktickRun(line, index);
    const ticks = line.slice(index, tickEnd);
    const close = line.indexOf(ticks, tickEnd);
    if (close === -1) {
      output += line[index];
      index += 1;
      continue;
    }

    output += " ".repeat(close + ticks.length - index);
    index = close + ticks.length;
  }
  return output;
}

function readBacktickRun(line: string, start: number): number {
  let index = start;
  while (line[index] === "`") index += 1;
  return index;
}
