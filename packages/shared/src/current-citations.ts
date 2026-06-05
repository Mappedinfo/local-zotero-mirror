import type { ZoteroCitationItem, ZoteroObsidianIndex, ZoteroObsidianIndexItem } from "./types.ts";

export type CurrentCitationActionKind = "note" | "zotero" | "pdf";

export interface CurrentCitationActionState {
  kind: CurrentCitationActionKind;
  enabled: boolean;
  title: string;
  target?: string;
}

export interface CurrentCitationLinkTarget {
  notePath?: string;
  zoteroUri?: string;
  pdfUri?: string;
}

export function findObsidianIndexItemForCitation(
  entry: ZoteroCitationItem,
  index: ZoteroObsidianIndex | null
): ZoteroObsidianIndexItem | undefined {
  if (!index) return undefined;
  const direct = index.items[entry.itemKey];
  if (direct) return direct;

  const keys = new Set([
    entry.itemKey,
    entry.citekey,
    entry.citation.citekey,
    ...(entry.citation.aliases ?? [])
  ].filter((key): key is string => Boolean(key)));

  for (const item of Object.values(index.items)) {
    const candidates = [
      item.itemKey,
      item.citekey,
      item.citation?.citekey,
      ...(item.citation?.aliases ?? [])
    ];
    if (candidates.some((candidate) => candidate && keys.has(candidate))) {
      return item;
    }
  }
  return undefined;
}

export function citationActionState(
  kind: CurrentCitationActionKind,
  entry: CurrentCitationLinkTarget
): CurrentCitationActionState {
  if (kind === "note") {
    return entry.notePath
      ? { kind, enabled: true, target: entry.notePath, title: `打开本地 note：${entry.notePath}` }
      : { kind, enabled: false, title: "尚未同步本地 note，无法打开。" };
  }
  if (kind === "zotero") {
    return entry.zoteroUri
      ? { kind, enabled: true, target: entry.zoteroUri, title: "在 Zotero 中打开条目" }
      : { kind, enabled: false, title: "缺少 Zotero 链接，无法打开条目。" };
  }
  return entry.pdfUri
    ? { kind, enabled: true, target: entry.pdfUri, title: "在 Zotero 中打开 PDF 附件" }
    : { kind, enabled: false, title: "缺少 PDF 链接，无法打开附件。" };
}
