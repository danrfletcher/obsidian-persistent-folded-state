# E10: the reload shape, proven against real Obsidian

Status: **PENDING — not yet run against real Obsidian.**

This file is required to exist and state the E10 outcome (spec: "The outcome (`emitted` or `not
emitted`), the Obsidian version and the annotations seen are written to `docs/reload-shape.md` and
committed"). It cannot be produced without a running Obsidian instance, so it was not fabricated
here: building this PR's code and its programmatic tests did not include access to a real
Obsidian desktop container.

## What's built and ready to run

`npm run test:e2e` (`scripts/e2e-reload-probe.mjs`) is the harness the spec asks for. It:

1. Attaches to a running Obsidian over Chrome DevTools Protocol (launch Obsidian with
   `--remote-debugging-port=9222`, per `use-desktop-container.md`).
2. Installs a temporary spy on `EditorView.prototype.dispatch` (removed when the script exits;
   nothing is added to the shipped plugin — no debug command, per F10) that records, for every
   dispatched transaction, whether it changed the document and whether it carried a
   `Transaction.userEvent` annotation.
3. Externally rewrites the open fixture note from outside Obsidian (simulating an agent, sync
   tool or git pull) and watches what gets dispatched next.
4. Keeps listening for `--observe-ms` afterwards so the same run can also capture, as the spec
   asks, which annotations accompany a user fold by gutter click, by the fold command, and
   Obsidian's own fold restore on open — perform those manually while it's running.
5. Writes the outcome, Obsidian's version and the full annotation log to this file, replacing it.

## To fill this in for real

From the Obsidian desktop container (`obsidian-development-template`, worktree bind-mounted,
launched per `use-desktop-container.md`):

```
npm run build
# copy main.js + manifest.json into the test vault's
# .obsidian/plugins/persistent-folded-state/, enable the plugin, open the fixture note
# launch/relaunch Obsidian with: --remote-debugging-port=9222

npm run test:e2e -- --note "<absolute path to the open fixture note>"
```

Then: fold the `## Tuesday` heading by gutter click, run "Forget stored folds for this note" or
any fold command, and relaunch Obsidian once to exercise its own native fold restore — all while
the script's observe window is open — before it writes its report. Commit the resulting
`docs/reload-shape.md`.

If the real result comes back `not emitted` (Obsidian replaces the editor state/view outright
rather than dispatching a transaction), per F10 this PR is flagged for a plan change and no
vault-modify fallback should be added here — that decision goes back to review, not into this PR.
