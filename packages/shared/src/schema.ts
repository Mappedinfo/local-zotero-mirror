import type { ZoteroBridgeSnapshot } from "./types.ts";

export function assertZoteroSnapshot(value: unknown): asserts value is ZoteroBridgeSnapshot {
  if (!isRecord(value)) {
    throw new Error("Zotero bridge returned a non-object snapshot.");
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) {
    throw new Error(`Unsupported Zotero snapshot schema version: ${String(value.schemaVersion)}`);
  }
  if (!Array.isArray(value.collections) || !Array.isArray(value.items)) {
    throw new Error("Zotero snapshot is missing collections or items.");
  }
  if ("nativeNotes" in value && !Array.isArray(value.nativeNotes)) {
    throw new Error("Zotero snapshot contains invalid native note data.");
  }
  if (!isRecord(value.library)) {
    throw new Error("Zotero snapshot is missing library metadata.");
  }

  for (const item of value.items) {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.title !== "string") {
      throw new Error("Zotero snapshot contains an invalid item.");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
