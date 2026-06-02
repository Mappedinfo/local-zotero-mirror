# Local Zotero Mirror

Local Zotero Mirror is an Obsidian desktop plugin that syncs Zotero collection structure, paper metadata, and Zotero native notes into local Markdown notes.

It is designed to work with the companion Zotero plugin, [Local Zotero Bridge](https://github.com/mappedinfo/local-zotero-bridge).

## Features

- Creates one canonical Markdown note per Zotero item.
- Regenerates collection index notes that link to canonical paper notes.
- Preserves user-written note sections outside managed blocks.
- Migrates Zotero native notes into a protected Markdown block.
- Supports opening Zotero items and PDF attachments from Obsidian commands and context menus.

## Development

```bash
npm install
npm test
npm run build
```

## Obsidian Release Assets

A GitHub release should upload:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag must match `manifest.json.version` exactly for Obsidian community plugin distribution.
