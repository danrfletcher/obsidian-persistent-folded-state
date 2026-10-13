# Persistent Folded State

An Obsidian plugin that preserves a note's block and task fold states (which headings, lists and
tasks are collapsed or expanded) across the kind of external file modification that would
normally reset them: an AI agent editing the file, a sync tool, a git pull, or anything else that
touches the file outside Obsidian's own editor.

## Status: PR-1

This PR builds the persistence layer every later PR sits on, and a minimal UI so it's usable and
testable on its own:

- **`src/fold-store.ts`** — an in-memory map of per-file fold records, flushed to Obsidian's own
  `data.json`. Debounces an ordinary change 150ms after the last one; flushes at once for a
  user-triggered forget or on unload/visibility-hidden/pagehide. Never throws on load, however
  corrupt or missing the on-disk file is — it just starts empty.
- **`src/types.ts`** — the on-disk/in-memory shapes. The contents of a single fold entry
  (anchor kind, indent, text, …) are deliberately left opaque here; a later PR defines that.
- **The "Forget stored folds for this note" command** — clears the active note's stored folds.
  Only visible with a Markdown editor open on a real file.
- **The settings tab** — one button, "Forget all stored folds", behind a confirmation modal.

Not in this PR: actually recording a fold when you fold something, the reload hook that restores
folds, anchors, matching text that moved, or the dormant-anchor reprieve. Those land in later PRs.

## Fold state is per device

Fold state is stored in this plugin's own `data.json`, which (like every Obsidian plugin's
`data.json`) is local to the vault on this device and is not synced by Obsidian Sync's settings
sync, nor expected to be portable across devices on its own.

## Development

```
npm install
npm run dev     # esbuild watch build
npm run build   # typecheck + production build -> main.js
npm run lint    # eslint src
npm test        # vitest
```
