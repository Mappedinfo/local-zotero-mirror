import { findPandocCitationGroups } from "./citations.ts";
import type {
  ZoteroBridgeSnapshot,
  ZoteroCitationMetadata,
  ZoteroItem,
  ZoteroObsidianIndex,
  ZoteroObsidianIndexItem
} from "./types.ts";

export type CitekeyAliasSource = "zotero" | "generated" | "history" | "confirmed";

export interface CitekeyAliasRecord {
  alias: string;
  itemKey: string;
  currentCitekey: string;
  source: CitekeyAliasSource;
  title?: string;
  updatedAt: string;
}

export interface CitekeyAliasRegistry {
  schemaVersion: 1;
  generatedAt: string;
  aliases: Record<string, CitekeyAliasRecord>;
}

export function emptyCitekeyAliasRegistry(now: string): CitekeyAliasRegistry {
  return {
    schemaVersion: 1,
    generatedAt: now,
    aliases: {}
  };
}

export function normalizeCitekeyAlias(value: string | undefined | null): string | undefined {
  const key = String(value || "").trim().replace(/^@/, "");
  return key || undefined;
}

export function isPoorGeneratedCitekey(value: string | undefined | null): boolean {
  const key = normalizeCitekeyAlias(value);
  return !key || /^\d{4}$/.test(key) || /^untitled(?:nodate)?$/i.test(key);
}

export function addCitekeyAlias(
  registry: CitekeyAliasRegistry,
  alias: string | undefined | null,
  item: { itemKey: string; currentCitekey: string; title?: string },
  source: CitekeyAliasSource,
  now: string
): boolean {
  const normalized = normalizeCitekeyAlias(alias);
  const current = normalizeCitekeyAlias(item.currentCitekey);
  if (!normalized || !current || !item.itemKey) return false;

  const existing = registry.aliases[normalized];
  if (
    existing &&
    existing.itemKey === item.itemKey &&
    existing.currentCitekey === current &&
    existing.source === source &&
    existing.title === item.title
  ) {
    return false;
  }

  registry.aliases[normalized] = {
    alias: normalized,
    itemKey: item.itemKey,
    currentCitekey: current,
    source,
    title: item.title,
    updatedAt: now
  };
  registry.generatedAt = now;
  return true;
}

export function buildCitekeyAliasRegistry(
  snapshot: ZoteroBridgeSnapshot,
  previousIndex: ZoteroObsidianIndex | null,
  existingRegistry: CitekeyAliasRegistry | null,
  now: string
): CitekeyAliasRegistry {
  const registry: CitekeyAliasRegistry = existingRegistry
    ? { ...existingRegistry, aliases: { ...existingRegistry.aliases }, generatedAt: now }
    : emptyCitekeyAliasRegistry(now);

  const existingByItemKey = new Map<string, CitekeyAliasRecord[]>();
  for (const record of Object.values(registry.aliases)) {
    const records = existingByItemKey.get(record.itemKey) ?? [];
    records.push(record);
    existingByItemKey.set(record.itemKey, records);
  }

  for (const item of snapshot.items) {
    const currentCitekey = currentCitekeyForItem(item);
    if (!currentCitekey) continue;
    const descriptor = { itemKey: item.key, currentCitekey, title: item.title };
    addCitekeyAlias(registry, currentCitekey, descriptor, item.citation?.citekeySource === "generated" ? "generated" : "zotero", now);
    addCitekeyAlias(registry, item.key, descriptor, "zotero", now);
    for (const alias of aliasesFromCitation(item.citation, item.citekey)) {
      addCitekeyAlias(registry, alias, descriptor, item.citation?.citekeySource === "generated" ? "generated" : "zotero", now);
    }

    const previous = previousIndex?.items[item.key];
    if (previous) {
      for (const alias of aliasesFromIndexItem(previous)) {
        addCitekeyAlias(registry, alias, descriptor, "history", now);
      }
    }

    for (const record of existingByItemKey.get(item.key) ?? []) {
      addCitekeyAlias(registry, record.alias, descriptor, record.source, now);
    }
  }

  return registry;
}

export function applyCitekeyAliasesToSnapshot(
  snapshot: ZoteroBridgeSnapshot,
  registry: CitekeyAliasRegistry | null
): ZoteroBridgeSnapshot {
  if (!registry) return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.map((item) => applyAliasesToItem(item, registry))
  };
}

export function aliasesForItemKey(registry: CitekeyAliasRegistry | null, itemKey: string): string[] {
  if (!registry) return [];
  return Object.values(registry.aliases)
    .filter((record) => record.itemKey === itemKey)
    .map((record) => record.alias);
}

export function rewriteMapFromRegistry(registry: CitekeyAliasRegistry | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!registry) return map;
  for (const record of Object.values(registry.aliases)) {
    if (record.alias !== record.currentCitekey && !isPoorGeneratedCitekey(record.currentCitekey)) {
      map.set(record.alias, record.currentCitekey);
    }
  }
  return map;
}

export interface CitekeyRewriteResult {
  markdown: string;
  replacements: number;
  citekeys: string[];
}

export function rewritePandocCitekeys(markdown: string, rewriteMap: Map<string, string>): CitekeyRewriteResult {
  if (rewriteMap.size === 0 || !markdown.includes("[@")) {
    return { markdown, replacements: 0, citekeys: [] };
  }

  const groups = findPandocCitationGroups(markdown);
  if (groups.length === 0) return { markdown, replacements: 0, citekeys: [] };

  let output = "";
  let cursor = 0;
  let replacements = 0;
  const replaced = new Set<string>();

  for (const group of groups) {
    output += markdown.slice(cursor, group.start);
    const nextRaw = group.raw.replace(/@([-A-Za-z0-9_:.]+)/g, (match, citekey: string) => {
      const replacement = rewriteMap.get(citekey);
      if (!replacement || replacement === citekey) return match;
      replacements += 1;
      replaced.add(citekey);
      return `@${replacement}`;
    });
    output += nextRaw;
    cursor = group.end;
  }

  output += markdown.slice(cursor);
  return {
    markdown: replacements > 0 ? output : markdown,
    replacements,
    citekeys: [...replaced]
  };
}

export function currentCitekeyForItem(item: ZoteroItem): string | undefined {
  return normalizeCitekeyAlias(item.citation?.citekey || item.citekey || item.key);
}

function applyAliasesToItem(item: ZoteroItem, registry: CitekeyAliasRegistry): ZoteroItem {
  const current = currentCitekeyForItem(item);
  if (!current) return item;
  const aliases = [
    ...(item.citation?.aliases ?? []),
    ...aliasesForItemKey(registry, item.key).filter((alias) => alias !== current)
  ];
  const citation: ZoteroCitationMetadata = {
    ...(item.citation ?? { citekey: current }),
    citekey: current,
    aliases: [...new Set(aliases.filter(Boolean))]
  };
  return {
    ...item,
    citekey: current,
    citation
  };
}

function aliasesFromCitation(citation: ZoteroCitationMetadata | undefined, legacyCitekey: string | undefined): string[] {
  return [legacyCitekey, citation?.citekey, ...(citation?.aliases ?? [])].filter((alias): alias is string => Boolean(alias));
}

function aliasesFromIndexItem(item: ZoteroObsidianIndexItem): string[] {
  return [
    item.itemKey,
    item.citekey,
    item.citation?.citekey,
    ...(item.citation?.aliases ?? [])
  ].filter((alias): alias is string => Boolean(alias));
}
