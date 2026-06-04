# Local Zotero Mirror

Local Zotero Mirror is an Obsidian desktop plugin that syncs Zotero collection structure, paper metadata, and Zotero native notes into local Markdown notes.

It is designed to work with the companion Zotero plugin, [Local Zotero Bridge](https://github.com/mappedinfo/local-zotero-bridge).

## Features

- Creates one canonical Markdown note per Zotero item.
- Regenerates collection index notes that link to canonical paper notes.
- Preserves user-written note sections outside managed blocks.
- Migrates Zotero native notes into a protected Markdown block.
- Writes a local full-text search index for Zotero-side Obsidian note search.
- Converts Zotero source tags into Obsidian-safe `zotero/...` tags while preserving originals in `zotero_tags`.
- Supports opening Zotero items and PDF attachments from Obsidian commands and context menus.
- Renders Pandoc-style citations such as `[@smith2024]` as APA parenthetical citations in reading mode.
- Shows a virtual `References` block in reading mode based on citekeys used in the current note.

## Installation and Updates

For BRAT, add this repository URL inside Obsidian: `https://github.com/Mappedinfo/local-zotero-mirror`. BRAT installs and updates from GitHub Releases.

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
