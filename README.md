# Persistent Folded State

An Obsidian plugin that keeps a note's folds (which headings, lists and tasks are collapsed or
expanded) across the things that normally reset them: an AI agent editing the file, a sync tool, a
`git pull`, any other program that writes the file outside Obsidian, and quitting and relaunching
the app.

It requires Obsidian 1.13.0 or later. It is not marked desktop-only, but it has not been tested on
a phone or tablet.

## What it does

- **Remembers your folds.** When you fold or unfold a block in a note, the plugin records which
  block it was, not just which line number.
- **Restores them after an outside edit.** When a note changes while it is open, or changed on disk
  while it was closed, the plugin matches the folds it stored against the new text and folds the
  blocks that match. It matches on the block's text first, then its position under its parent, then
  on similar text, so a lesson that was reworded or moved a few lines still comes back folded.
- **Waits for the note to load.** On open, restore waits until the pane shows the note's real text
  before it touches any fold, so an empty pane never wipes a stored fold.
- **Keeps folds it could not place for 10 minutes.** A fold that matches nothing yet is kept as
  dormant and retried each time the note reloads. It is forgotten after 10 minutes.
- **Adopts what you already have.** The first time a note is opened, the folds Obsidian already
  shows are recorded as they are. Nothing is folded or unfolded.
- **Follows renames and deletes.** Renaming or moving a note or folder in Obsidian carries its
  stored folds along. Deleting one removes them. A rename made outside Obsidian is cleaned up the
  next time the plugin loads.
- **Works inside embeds.** Folds you make by clicking inside an embedded block or note
  (`![[Note#Heading]]`, `![[Note#^block]]`) are stored against the host note and restored when the
  embed renders, in Live Preview and Reading view.

## Commands

| Command | What it does |
|---|---|
| Forget stored folds for this note | Clears the active note's stored folds and those of the embeds in it. Nothing changes on screen. |
| Copy diagnostic log | Copies the plugin's diagnostic log to the clipboard, ready to paste into a note or a bug report. |

## Settings

One control: **Forget all stored folds** clears every note's and every embed's stored folds on this
device, after a confirmation. It cannot be undone.

## Diagnostic log

The plugin keeps a short log in its own folder (`diagnostic-log.jsonl`, newest 1,000 lines) so a
"my folds randomly opened" report can be traced to the exact pass that caused it. Each line holds a
timestamp, the note's path, counts and two short codes for which pass ran and what it did. It never
holds note text, headings or fold text, and there is no setting to turn it off.

## Known limits

- A fold arrow inside an embed that the plugin cannot pair with a line of the embedded text (its
  rendered text differs too much from the source line, for example) is left exactly as Obsidian
  shows it. A fold you make on it is not recorded, and the stored folds never undo it, so when a
  fold of that kind is on screen the embed can differ from the stored set.
- When an embed runs out of the per-host comparison budget while its stored folds are matched to a
  changed source, the folds that were placed are applied and the ones that could not be placed are
  left out. Nothing is unfolded.
- A link to a heading (`![[Note#Heading]]`) whose embed has stored folds waits 10 seconds after it
  stops matching the host's text before its folds go dormant, so a heading you rename in Obsidian
  (which rewrites the link) moves the folds to the new heading. A link edited by hand starts its
  dormant period about 10 seconds later than a block or whole-note link does.
- The matcher handles up to 500 stored folds per note.

## Fold state is per device

Fold state is stored in this plugin's own `data.json`, which (like every Obsidian plugin's
`data.json`) is local to the vault on this device. Obsidian Sync's settings sync does not carry it,
and it is not meant to be portable across devices on its own.

## Install

Search for **Persistent Folded State** under Settings, then Community plugins, and enable it. To
install by hand instead, download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/danrfletcher/obsidian-persistent-folded-state/releases/latest)
into `<vault>/.obsidian/plugins/persistent-folded-state/`.

## Development

```
npm install
npm run dev     # esbuild watch build
npm run build   # typecheck + production build -> main.js
npm run lint    # eslint src
npm test        # vitest
```

The `docs/` folder holds notes from probing real Obsidian behaviour (reload shape, embeds).
Released under the MIT licence.
