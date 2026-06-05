import type { ZoteroCitationResponse } from "./types.ts";

export function missingCitekeySummary(citekeys: string[]): string {
  return `缺失 citekey：${citekeys.join(", ")}`;
}

export function missingCitekeyGuidance(citekeys: string[], source?: ZoteroCitationResponse["source"] | "none", error?: string): string {
  const lines = [
    missingCitekeySummary(citekeys),
    "处理：先运行 Sync Zotero Library。",
    "如果仍缺失，请在 Zotero 中检查该条目是否存在，并确认 Better BibTeX / Extra 里的 Citation Key 与这里完全一致。",
    "如果刚更新过 Zotero 插件，请确认 Better BibTeX 已重新启用并让 Zotero 完成重启后再同步。"
  ];
  if (source && source !== "zotero") lines.push(`当前引用来源：${source}`);
  if (error) lines.push(`Bridge warning：${error}`);
  return lines.join("\n");
}
