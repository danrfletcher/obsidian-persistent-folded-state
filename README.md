# Persistent Folded State

An Obsidian plugin that preserves a note's block and task fold states (which headings, lists and
tasks are collapsed or expanded) across the kind of external file modification that would
normally reset them: an AI agent editing the file, a sync tool, a git pull, or anything else that
touches the file outside Obsidian's own editor.

## Status: PR-5

Restore is wired in: on a settled external edit, the plugin snapshots the stored anchors for
that note, matches them against the new text (PR-4's matcher), and dispatches tagged CM6 fold
effects for whatever matched — in every open pane, one settle timer and one restore pass per
pane, all reading and writing the one shared `FoldStore`.

- **`src/fold-restorer.ts`** — the CM6-level restore pass: snapshots stored anchors at settle
  time, matches with a real (not no-op) yielding scheduler, dispatches tagged fold effects, and
  refreshes the note's stored content hash afterwards.
- **`src/restore-plan.ts`** — the pure planning step from (the matcher's own decision, live
  folded ranges, cursor position, which anchors the store still holds) to (ranges to fold now,
  ranges deferred until the cursor leaves them).
- **`src/describe-fold.ts`** — now builds a real `Anchor` (PR-3's `buildAnchors`) instead of
  PR-2's line-local guess; a PR-2-era raw-text record is discarded on load rather than matched.
- **`src/editor-watcher.ts`** — wires the restore pass into the settle timer and re-checks
  deferred (cursor-inside) targets on every later update.

Earlier PRs: PR-1 built the persistence layer (`src/fold-store.ts`) and a minimal UI (the
"Forget stored folds for this note" command, the settings tab's "Forget all stored folds"
button). PR-2 added the editor watcher, fold recording and the settle timer. PR-3 added the pure
anchor builder (`src/anchors.ts`, `src/normalize.ts`). PR-4 added the pure matcher
(`src/matcher.ts`, `src/similarity.ts`).

Not in this PR: the dormant-fold retry window and first-open baseline adoption (PR-6), restore
on reopen/restart/rename/delete (PR-7).

## Embed folds: known limits

- A fold arrow inside an embed that the plugin cannot pair with a line of the embedded text (its
  rendered text differs too much from the source line, for example) is left exactly as Obsidian
  shows it. A fold Dan makes on it is not recorded, and the stored folds never undo it, so when a
  fold of that kind is on screen the embed can differ from the stored set ("the stored set wins"
  is not strict for it). The plugin does not guess which line such an arrow belongs to.
- When an embed runs out of the per-host comparison budget while its stored folds are matched to
  a changed source, the folds that were placed are applied, and the ones that could not be placed
  are left out; nothing is unfolded.
- A link to a heading (`![[Note#Heading]]`) whose embed has stored folds waits 10 seconds after it
  stops matching the host's text before its folds go dormant, so a heading Dan renames in Obsidian
  (which rewrites the link) moves the folds to the new heading instead of starting the 10-minute
  clock on the old one. The wait is measured while the note is open; a link edited by hand starts
  its dormant period about 10 seconds later than a block or whole-note link does.

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
