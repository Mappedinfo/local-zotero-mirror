export type YamlValue = string | number | boolean | string[] | undefined | null;

export const MANAGED_FRONTMATTER_KEYS = [
  "zotero_key",
  "citekey",
  "citation_aliases",
  "citekey_source",
  "citation_apa",
  "reference_apa",
  "bibtex",
  "title",
  "authors",
  "year",
  "item_type",
  "publication",
  "doi",
  "url",
  "collections",
  "tags",
  "zotero_tags",
  "zotero_uri",
  "pdf_uri",
  "zotero_version",
  "zotero_native_note_count",
  "zotero_native_notes_last_synced",
  "last_synced",
  "zotero_deleted",
  "zotero_note_key",
  "zotero_parent_key",
  "zotero_note_deleted"
] as const;

export function splitFrontmatter(markdown: string): { frontmatter: string[]; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0] !== "---") {
    return { frontmatter: [], body: normalized };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex === -1) {
    return { frontmatter: [], body: normalized };
  }

  return {
    frontmatter: lines.slice(1, closingIndex),
    body: lines.slice(closingIndex + 1).join("\n").replace(/^\n/, "")
  };
}

export function readFrontmatterString(markdown: string, key: string): string | undefined {
  const { frontmatter } = splitFrontmatter(markdown);
  for (const line of frontmatter) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    return unquoteYamlString(match[2].trim());
  }
  return undefined;
}

export function readFrontmatterStringArray(markdown: string, key: string): string[] | undefined {
  const { frontmatter } = splitFrontmatter(markdown);
  for (let index = 0; index < frontmatter.length; index += 1) {
    const match = frontmatter[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match || match[1] !== key) continue;

    const inlineValue = match[2].trim();
    if (inlineValue.startsWith("[") && inlineValue.endsWith("]")) {
      try {
        const parsed = JSON.parse(inlineValue);
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : undefined;
      } catch {
        return undefined;
      }
    }

    const values: string[] = [];
    for (let lineIndex = index + 1; lineIndex < frontmatter.length; lineIndex += 1) {
      const line = frontmatter[lineIndex];
      if (/^[A-Za-z0-9_-]+:/.test(line)) break;
      const itemMatch = line.match(/^\s*-\s*(.*)$/);
      if (itemMatch) values.push(unquoteYamlString(itemMatch[1].trim()));
    }
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

export function mergeManagedFrontmatter(markdown: string, managedFields: Record<string, YamlValue>): string {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const managedKeys = new Set(Object.keys(managedFields));
  const preserved = removeKeysFromYamlLines(frontmatter, managedKeys);
  const generated = yamlLinesFromFields(managedFields);
  const merged = [...trimTrailingBlankLines(preserved), ...generated];

  return ["---", ...merged, "---", "", body.replace(/^\n/, "")].join("\n").replace(/\n+$/, "\n");
}

export function yamlLinesFromFields(fields: Record<string, YamlValue>): string[] {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const entry of value) {
        lines.push(`  - ${quoteYamlString(entry)}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }

  return lines;
}

function removeKeysFromYamlLines(lines: string[], keys: Set<string>): string[] {
  const output: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const topLevelKey = line.match(/^([A-Za-z0-9_-]+):(?:\s|$)/)?.[1];
    if (topLevelKey) {
      skipping = keys.has(topLevelKey);
    }

    if (!skipping) {
      output.push(line);
    }
  }

  return output;
}

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return quoteYamlString(value);
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function unquoteYamlString(value: string): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value.replace(/^['"]|['"]$/g, "");
  }
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1].trim() === "") {
    copy.pop();
  }
  return copy;
}
