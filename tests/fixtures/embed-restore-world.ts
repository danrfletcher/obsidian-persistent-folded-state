/**
 * Helpers for the embed-restore tests (ticket warkworth-21, PR-5): a real `EmbedFoldRestorer`
 * over the PR-4 `World` (mock Obsidian app, real `FoldStore`, real recorder, jsdom hosts shaped
 * like the probe's recorded DOM), and the fake-timer steps that carry a render through its
 * coalescing window, its pass, and the single re-check after it.
 *
 * The restorer is wired exactly as `src/main.ts` wires it: the same readers, and
 * `whenRecorded` is the recorder's own `whenIdle`. Its clicks are scripted (untrusted, no pointer
 * events), which the World's `isTrusted` seam, like real Obsidian's input, tells apart from a
 * person's: so whether a restore "records" is decided by the real recorder, not by a test double.
 */
import { vi } from "vitest";
import { EmbedFoldRestorer, EMBED_VERIFY_DELAY_MS } from "../../src/embed-fold-restorer";
import type { EmbedFoldRestorerDeps } from "../../src/embed-fold-restorer";
import { EMBED_RENDER_SETTLE_MS } from "../../src/embed-render-coalescer";
import type { World } from "./embed-recording-world";
import type { Workspace } from "obsidian";

export function attachRestorer(w: World, overrides: Partial<EmbedFoldRestorerDeps> = {}): EmbedFoldRestorer {
	const restorer = new EmbedFoldRestorer({
		workspace: w.app.workspace as unknown as Workspace,
		store: w.store,
		readHostText: (host) => host.view.getViewData(),
		readNote: async (path) => {
			const file = w.app.vault.getFileByPath(path);
			return file === null ? null : await w.app.vault.cachedRead(file);
		},
		resolveLink: (linktext, sourcePath) => w.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null,
		whenRecorded: () => w.recorder.whenIdle(),
		...overrides,
	});
	restorer.attach(document);
	return restorer;
}

/** Lets every queued microtask, due zero-delay timer and running pass finish, without moving the
 * clock more than a tick. */
export async function drain(w: World, restorer: EmbedFoldRestorer): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await vi.advanceTimersByTimeAsync(0);
		await w.settle();
		await restorer.whenIdle();
	}
}

/** Carries renders through the 150 ms window and the pass, without the later re-check. */
export async function firstPass(w: World, restorer: EmbedFoldRestorer): Promise<void> {
	await drain(w, restorer);
	await vi.advanceTimersByTimeAsync(EMBED_RENDER_SETTLE_MS);
	await drain(w, restorer);
}

/** The pass and the re-check after it: everything a render of an embed will ever do. */
export async function settleRestore(w: World, restorer: EmbedFoldRestorer): Promise<void> {
	await firstPass(w, restorer);
	await vi.advanceTimersByTimeAsync(EMBED_VERIFY_DELAY_MS);
	await drain(w, restorer);
}

/** The arrow texts an embed shows folded, in DOM order: each row's own text, not its children's. */
export function foldedRows(embed: Element): string[] {
	return Array.from(embed.querySelectorAll(".list-collapse-indicator.is-collapsed, .heading-collapse-indicator.is-collapsed")).map((a) =>
		Array.from(a.parentElement?.childNodes ?? [])
			.filter((n) => n.nodeType === 3)
			.map((n) => n.textContent ?? "")
			.join("")
			.trim()
	);
}

/** True when the arrow reads as folded, as Obsidian's own toggle leaves it. */
export function isFolded(arrow: Element): boolean {
	return arrow.classList.contains("is-collapsed");
}
