/**
 * Puts back the folds Dan stored for an embed when it renders (ticket warkworth-21, PR-5, G2,
 * G9, G13, E4, E5, E14). This is the read-back half of the feature: PR-4's recorder
 * (src/embed-fold-recorder.ts) writes an embed's folds when Dan clicks its fold arrows; this
 * reads them back and re-applies them when the embed renders again, after closing and reopening
 * the host, relaunching Obsidian, flipping Live Preview and Reading view, opening the same host
 * in two panes, or editing the source.
 *
 * Render hook (from the recorded probe, docs/embed-probe.md): an embedded note renders inside
 * `.internal-embed.markdown-embed`, in a Live Preview and in a Reading view host, as a short burst
 * of DOM changes in that element; the element gains `is-loaded` as it renders. So a
 * MutationObserver on each document watches for an embed element being added, its content
 * changing, or its own class changing. Class changes on fold arrows are NOT renders and are
 * ignored (they are Dan's clicks, or this restore's own toggles). Renders are coalesced per embed
 * (src/embed-render-coalescer.ts): 150 ms after the last one, one pass runs. Combinations the
 * probe could not show to be supported (`EMBED_CAPABILITIES`) are skipped and never guessed at
 * (G18); when none is supported no observer is registered at all.
 *
 * One pass, for one embed:
 *  1. The embed must sit in a workspace markdown view in Live Preview or Reading view
 *     (`detectEmbedHost`); a hover or page preview, canvas card or Bases view is ignored (E13, F3).
 *  2. Its key and slice are resolved from the host's source text exactly as the recorder does
 *     (`resolveEmbedChain`): occurrence by document order (G7), nested embeds by chain.
 *  3. The record under that key is read with `store.getEmbed`. Nothing else in the store is read:
 *     never `files[source]` (F2). No record, or an empty one, means the embed starts fully
 *     expanded and nothing Obsidian shows is adopted (G13).
 *  4. The record's folds are placed on the slice text only (src/embed-rematch.ts, PR-6): the
 *     same slice as the record's hash re-applies the stored set without the matcher (G4); a
 *     changed slice (an agent, sync or `git pull` rewrote the source, or Dan edited it, G3) is
 *     re-matched with `buildAnchors` and `matchAnchors` unchanged, within 500 folds per embed
 *     and 5,000 comparisons per host per render pass, in yielded chunks (E7).
 *     `planEmbedRestore` then compares the result with what the embed's arrows show: stored
 *     folds Obsidian did not restore are applied, strays are unfolded (E4).
 *  5. After a successful re-match of a changed slice the record's anchors and content hash are
 *     brought up to date, so a second edit matches against the latest state. An embed whose
 *     slice is empty, whose target block is gone, or that ran out of budget keeps its record as
 *     it was (dormancy is PR-7's).
 *  6. The changes are made by clicking the embed's own arrows, the hook the probe proved.
 *
 * Restore never records: the toggles it makes are scripted clicks (untrusted, with no pointer
 * sequence), which the recorder's click-only classifier calls non-user (rule 2). Its one store
 * write is the record refresh in step 5, and only when the slice changed. A user click always wins (E3):
 * before reading the DOM the pass waits for the recorder to finish what it has queued, and if the
 * embed's record changed while the pass was matching it starts over from the new record.
 *
 * Writes nothing to the host or source note (F7), adds no element, class or control to the page
 * (F1), and uses no browser storage (F10). Reads notes through the injected read-only readers.
 */
import type { Workspace } from "obsidian";
import { buildAnchors, parseAnchor } from "./anchors";
import type { Anchor, AnchoredBlock } from "./anchors";
import { EMBED_CAPABILITIES } from "./embed-capabilities";
import type { EmbedCapability, EmbedHostModeId, EmbedKind } from "./embed-capabilities";
import { planEmbedPass } from "./embed-anchor-dormancy";
import { HEADING_RENAME_GRACE_MS } from "./embed-dormancy";
import { COLLAPSED_CLASS, EMBED_SELECTOR, blockIndexForToggle, describeArrows, embedKindOf, embedLevels, resolveEmbedChain } from "./embed-fold-recorder";
import { detectEmbedHost } from "./embed-host";
import type { EmbedHost } from "./embed-host";
import { parseEmbedLinktext } from "./embed-key";
import { EMBED_RENDER_SETTLE_MS, EmbedRenderCoalescer } from "./embed-render-coalescer";
import { HostComparisonBudget } from "./embed-rematch";
import { planEmbedRestore } from "./embed-restore-plan";
import type { LiveArrow } from "./embed-restore-plan";
import type { MatcherOptions } from "./matcher";
import type { EmbedFoldRecord, EmbedIdentity } from "./types";

/** Once a pass has run, the embed is looked at once more after this long (ms), in case Obsidian
 * restored its own folds after the pass and without another render (E4, "late native restore"). */
export const EMBED_VERIFY_DELAY_MS = 400;
/** How many times one pass starts over because the embed's record changed under it. */
const MAX_RESTARTS = 3;
/** A render of an embed that arrives within this long (ms) of the restorer's own arrow click on
 * it is taken as that click's echo, not as a render of its own (PR-5 R3). */
const OWN_CLICK_ECHO_MS = 600;
/** How many echo renders in a row may each start a pass that clicks again. A fourth is not
 * scheduled: if Obsidian re-renders an embed on a toggle and puts the fold back from its own
 * memory, the restorer would otherwise click it every ~150 ms for ever. Real renders (a source
 * edit, the host re-opened) are not echoes and always start a pass. */
const MAX_ECHO_PASSES = 3;

export interface EmbedFoldRestorerDeps {
	workspace: Workspace;
	/** Read for every pass; written (`setEmbed`) only to bring an embed's anchors and content hash
	 * up to date after a successful re-match of a changed slice (PR-6, G3). */
	store: { getEmbed(id: EmbedIdentity): EmbedFoldRecord | undefined; setEmbed(record: EmbedFoldRecord): void };
	/** The host's current source text. */
	readHostText: (host: EmbedHost) => string;
	/** The current text of a vault note, or null when it does not exist. Read-only. */
	readNote: (path: string) => Promise<string | null>;
	/** Obsidian's link resolver: link text as written in `sourcePath` to a vault path, or null. */
	resolveLink: (linktext: string, sourcePath: string) => string | null;
	/** Optional: the offset in the host's source text that a rendered host-level embed element
	 * stands for (Live Preview can tell). Used only to tell identical embeds apart. */
	positionOf?: (host: EmbedHost, el: Element) => number | null;
	/** Resolves once every fold the recorder has seen has reached the store, so a click Dan made
	 * just before a pass is part of what the pass reads (E3). */
	whenRecorded: () => Promise<void>;
	/** Defaults to `EMBED_CAPABILITIES`; a test overrides it to model a gap. */
	capabilities?: Readonly<Record<EmbedHostModeId, Readonly<Record<EmbedKind, EmbedCapability>>>>;
	/** Defaults to `EMBED_RENDER_SETTLE_MS` (150). */
	renderDelayMs?: number;
	/** Defaults to `EMBED_VERIFY_DELAY_MS`. */
	verifyDelayMs?: number;
	/** Test seam for the matcher's caps; production uses the matcher's defaults unchanged. */
	matcherOptions?: MatcherOptions;
	/** Comparisons one host may spend per render pass, shared by all its embeds (E7). Defaults to
	 * 5,000 (the matcher's own cap); a test lowers it. */
	hostComparisonBudget?: number;
	/** PR-7 (G6, E6): brings the dormancy of the host's embed records up to date with its source
	 * text; called once per host per render pass, before the embeds are read. Optional. */
	dormancy?: { reconcileHost(hostPath: string, hostText: string): Promise<{ deferred: number } | void> };
	/** How long after a reconcile that held heading-linked records back (PR-8 R1) the host is
	 * looked at again. Defaults to `HEADING_RENAME_GRACE_MS` plus a margin; a test shortens it. */
	dormancyRecheckMs?: number;
	/** Wall clock in ms for the dormant retry (PR-7). Defaults to `Date.now`. */
	now?: () => number;
}

/** The window an element lives in (a pop-out window has its own `MutationObserver`). */
type PopoutWindow = Window & { MutationObserver: typeof MutationObserver };

function isElement(node: unknown): node is Element {
	return typeof node === "object" && node !== null && (node as { nodeType?: unknown }).nodeType === 1;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function recordFoldsKey(record: EmbedFoldRecord | undefined): string {
	return record === undefined ? "none" : JSON.stringify(record.folds);
}

export class EmbedFoldRestorer {
	private readonly deps: EmbedFoldRestorerDeps;
	private readonly capabilities: Readonly<Record<EmbedHostModeId, Readonly<Record<EmbedKind, EmbedCapability>>>>;
	private readonly observers = new Map<Document, MutationObserver>();
	/** The render window for each embed. Not the store's flush timer, and not `verifier`. */
	private readonly renders: EmbedRenderCoalescer<Element, number>;
	/** The single re-check after a pass; a separate instance so a render never mistakes it for one. */
	private readonly verifier: EmbedRenderCoalescer<Element, number>;
	private readonly generations = new WeakMap<Element, number>();
	private readonly inFlight = new Set<Promise<void>>();
	/** One comparison budget per host path, for the render burst in progress (E7). A host's budget
	 * is dropped once that host is quiet (no pass running for one of its embeds and no render
	 * window open on one), so the next render of it starts a new burst with a full budget, however
	 * busy other hosts are (PR-6 R7). */
	private readonly budgets = new Map<string, HostComparisonBudget>();
	/** The dormancy reconcile of each host in the burst in progress (PR-7), with the host text it
	 * was made for; dropped with `budgets`, and made again when the text has changed (PR-7 R6). */
	private readonly reconciled = new Map<string, { text: string; done: Promise<void> }>();
	/** How many passes are running for each host path. */
	private readonly hostPasses = new Map<string, number>();
	/** When the restorer last clicked an arrow of each embed (ms). */
	private readonly lastOwnClick = new WeakMap<Element, number>();
	/** How many echo renders in a row each embed has had since a pass last left it alone. */
	private readonly echoStreak = new WeakMap<Element, number>();
	/** The pending second look at a host whose reconcile held records back. */
	private readonly rechecks = new Map<string, number>();
	private renderSeq = 0;
	private disposed = false;

	constructor(deps: EmbedFoldRestorerDeps) {
		this.deps = deps;
		this.capabilities = deps.capabilities ?? EMBED_CAPABILITIES;
		this.renders = new EmbedRenderCoalescer<Element, number>((el) => this.startPass(el, true), deps.renderDelayMs ?? EMBED_RENDER_SETTLE_MS);
		this.verifier = new EmbedRenderCoalescer<Element, number>((el) => this.startPass(el, false), deps.verifyDelayMs ?? EMBED_VERIFY_DELAY_MS);
	}

	/** Starts watching `doc` (the main document, or a pop-out window's) and schedules a pass for
	 * every embed already on the page. Registers nothing when the probe supports no host mode and
	 * embed kind at all. */
	attach(doc: Document): void {
		if (this.disposed || this.observers.has(doc) || !this.anySupported()) return;
		const win = (doc.defaultView ?? window) as PopoutWindow;
		const observer = new win.MutationObserver((records) => this.onMutations(records));
		observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
		this.observers.set(doc, observer);
		for (const el of Array.from(doc.querySelectorAll(EMBED_SELECTOR))) this.scheduleRender(el);
	}

	detach(doc: Document): void {
		const observer = this.observers.get(doc);
		if (observer === undefined) return;
		observer.disconnect();
		this.observers.delete(doc);
		this.renders.cancelWhere((el) => el.ownerDocument === doc);
		this.verifier.cancelWhere((el) => el.ownerDocument === doc);
	}

	/** Stops everything: no observer, no pending pass, and a pass in flight does nothing more. */
	dispose(): void {
		this.disposed = true;
		for (const observer of this.observers.values()) observer.disconnect();
		this.observers.clear();
		this.renders.cancelAll();
		this.verifier.cancelAll();
		this.budgets.clear();
		this.reconciled.clear();
		for (const timer of this.rechecks.values()) window.clearTimeout(timer);
		this.rechecks.clear();
	}

	/** Schedules a pass for every embed on the page, or only those of `hostPath`. Used when the
	 * records changed without a render: a heading rename migrated them (PR-8 R1), or the wait on
	 * a heading-linked record is over. */
	rescan(hostPath?: string): void {
		for (const doc of this.observers.keys()) {
			for (const el of Array.from(doc.querySelectorAll(EMBED_SELECTOR))) {
				if (hostPath === undefined || this.hostPathOf(el) === hostPath) this.scheduleRender(el);
			}
		}
	}

	/** How many embeds have a render window open. */
	get pendingRenders(): number {
		return this.renders.pendingCount;
	}

	/** Resolves once no pass is running (a pass waiting out its window is not running). */
	async whenIdle(): Promise<void> {
		while (this.inFlight.size > 0) await Promise.all(Array.from(this.inFlight));
	}

	private anySupported(): boolean {
		return Object.values(this.capabilities).some((kinds) => Object.values(kinds).some((cap) => cap.verdict === "supported"));
	}

	// --- Detecting renders ---------------------------------------------------------------------

	private scheduleRender(el: Element): void {
		if (this.disposed || !el.isConnected) return;
		const clickedAt = this.lastOwnClick.get(el);
		if (clickedAt !== undefined && (this.deps.now ?? Date.now)() - clickedAt < OWN_CLICK_ECHO_MS) {
			const streak = (this.echoStreak.get(el) ?? 0) + 1;
			this.echoStreak.set(el, streak);
			if (streak > MAX_ECHO_PASSES) return; // the restorer's own clicks keep coming back as renders: stop
		} else {
			this.echoStreak.delete(el);
		}
		this.verifier.cancel(el);
		this.renders.render(el, ++this.renderSeq);
	}

	private onMutations(records: MutationRecord[]): void {
		if (this.disposed) return;
		for (const record of records) {
			const target = record.target;
			if (record.type === "attributes") {
				// Only the embed element's own class (`is-loaded`): an arrow's class is a fold, not a render.
				if (isElement(target) && target.matches(EMBED_SELECTOR)) this.scheduleRender(target);
				continue;
			}
			for (const removed of Array.from(record.removedNodes)) {
				if (!isElement(removed)) continue;
				// The embed left the page (the host closed, or it was replaced): its pass is cancelled.
				this.renders.cancelWhere((el) => removed.contains(el));
				this.verifier.cancelWhere((el) => removed.contains(el));
			}
			const within = isElement(target) ? target.closest(EMBED_SELECTOR) : (target.parentElement?.closest(EMBED_SELECTOR) ?? null);
			if (within !== null) this.scheduleRender(within);
			for (const added of Array.from(record.addedNodes)) {
				if (!isElement(added)) continue;
				if (added.matches(EMBED_SELECTOR)) this.scheduleRender(added);
				for (const inner of Array.from(added.querySelectorAll(EMBED_SELECTOR))) this.scheduleRender(inner);
			}
		}
	}

	// --- A pass --------------------------------------------------------------------------------

	/** The path of the host a rendered embed sits in, or null when it is in none. */
	private hostPathOf(el: Element): string | null {
		try {
			return detectEmbedHost(this.deps.workspace, el)?.file.path ?? null;
		} catch {
			return null;
		}
	}

	/** Drops `hostPath`'s budget and reconcile once none of its embeds has a pass running or a
	 * render window open. */
	private releaseHostIfQuiet(hostPath: string): void {
		if ((this.hostPasses.get(hostPath) ?? 0) > 0) return;
		if (this.renders.hasWhere((el) => this.hostPathOf(el) === hostPath)) return;
		this.budgets.delete(hostPath);
		this.reconciled.delete(hostPath);
	}

	private startPass(el: Element, verifyAfter: boolean): void {
		if (this.disposed || !el.isConnected) return;
		const hostPath = this.hostPathOf(el);
		if (hostPath !== null) this.hostPasses.set(hostPath, (this.hostPasses.get(hostPath) ?? 0) + 1);
		const generation = (this.generations.get(el) ?? 0) + 1;
		this.generations.set(el, generation);
		const task: Promise<void> = this.restore(el, generation)
			.catch((err: unknown) => {
				console.error("persistent-folded-state: embed restore failed", err);
			})
			.then(() => {
				if (verifyAfter && !this.disposed && el.isConnected && this.generations.get(el) === generation && (this.echoStreak.get(el) ?? 0) < MAX_ECHO_PASSES) {
					this.verifier.render(el, generation);
				}
			})
			.finally(() => {
				this.inFlight.delete(task);
				if (hostPath !== null) {
					const left = (this.hostPasses.get(hostPath) ?? 1) - 1;
					if (left > 0) this.hostPasses.set(hostPath, left);
					else this.hostPasses.delete(hostPath);
					this.releaseHostIfQuiet(hostPath);
				}
			});
		this.inFlight.add(task);
	}

	/** Reconciles the host's embed records once per render burst (dropped with the budgets), and
	 * again when the host text is no longer the text the earlier reconcile was made for: a record
	 * revived or stamped by that edit must be seen before its embed is restored (PR-7 R6). A
	 * failure is logged and leaves every record as it was. */
	private reconcileHost(hostPath: string, hostText: string): Promise<void> {
		const dormancy = this.deps.dormancy;
		if (dormancy === undefined) return Promise.resolve();
		const earlier = this.reconciled.get(hostPath);
		if (earlier !== undefined && earlier.text === hostText) return earlier.done;
		// One reconcile at a time per host: the second waits for the first.
		const done = (earlier?.done ?? Promise.resolve())
			.then(() => dormancy.reconcileHost(hostPath, hostText))
			.then((result) => {
				if (result !== undefined && result.deferred > 0) this.scheduleRecheck(hostPath);
			})
			.catch((err: unknown) => {
				console.error("persistent-folded-state: embed dormancy failed", err);
			});
		this.reconciled.set(hostPath, { text: hostText, done });
		return done;
	}

	/** A reconcile held heading-linked records back: once the wait is over the host is reconciled
	 * again, which needs a fresh pass because nothing else re-renders its embeds. */
	private scheduleRecheck(hostPath: string): void {
		if (this.disposed || this.rechecks.has(hostPath)) return;
		const timer = window.setTimeout(() => {
			this.rechecks.delete(hostPath);
			if (this.disposed) return;
			this.reconciled.delete(hostPath);
			this.rescan(hostPath);
		}, this.deps.dormancyRecheckMs ?? HEADING_RENAME_GRACE_MS + 500);
		this.rechecks.set(hostPath, timer);
	}

	private budgetFor(hostPath: string): HostComparisonBudget {
		let budget = this.budgets.get(hostPath);
		if (budget === undefined) {
			budget = new HostComparisonBudget(this.deps.hostComparisonBudget);
			this.budgets.set(hostPath, budget);
		}
		return budget;
	}

	private stale(el: Element, generation: number): boolean {
		return this.disposed || !el.isConnected || this.generations.get(el) !== generation;
	}

	private supported(host: EmbedHost, el: Element): boolean {
		const src = el.getAttribute("src") ?? "";
		const parsed = parseEmbedLinktext(src.includes("%") ? safeDecode(src) : src);
		if (parsed === null) return false;
		return this.capabilities[host.mode][embedKindOf(parsed.subpath)].verdict === "supported";
	}

	private async restore(el: Element, generation: number): Promise<void> {
		for (let attempt = 0; attempt < MAX_RESTARTS; attempt++) {
			// A click Dan made before this pass has to be in the store before the pass reads it.
			await this.deps.whenRecorded();
			if (this.stale(el, generation)) return;

			const host = detectEmbedHost(this.deps.workspace, el);
			if (host === null || !this.supported(host, el)) return;

			const { levels, outermost } = embedLevels(el, host.view.containerEl);
			let hostText: string;
			let position: number | null = null;
			try {
				hostText = this.deps.readHostText(host);
				position = this.deps.positionOf?.(host, outermost) ?? null;
			} catch {
				return;
			}
			// PR-7: a retargeted or broken embed's record goes dormant, and one that is back is
			// revived, before any embed of this host is read. Once per host per pass.
			await this.reconcileHost(host.file.path, hostText);
			if (this.stale(el, generation)) return;
			const resolved = await resolveEmbedChain({
				hostPath: host.file.path,
				hostText,
				levels,
				position,
				resolveLink: this.deps.resolveLink,
				readNote: this.deps.readNote,
				isCancelled: () => this.stale(el, generation),
			});
			if (resolved === null || this.stale(el, generation)) return;

			const snapshot = this.deps.store.getEmbed(resolved.identity);
			// A record still stamped dormant after the host was reconciled could not be assessed
			// (a read failed): its folds are neither applied nor changed on a guess (E6, G6).
			if (snapshot?.dormantSince !== undefined) return;
			const storedAnchors: Anchor[] = [];
			for (const raw of snapshot?.folds ?? []) {
				const anchor = parseAnchor(raw);
				if (anchor !== null) storedAnchors.push(anchor);
			}

			// The source note changed so that the slice is empty: nothing to place, nothing to change.
			// The record is left as it was.
			if (resolved.sliceText.trim() === "") return;

			// The same builder and matcher a note's folds use, over the slice text alone (G3). The
			// dormant anchors (PR-7, G14) are retried in the same matcher call, on every settled
			// render of this embed (E5), sharing the host's comparison budget (E7).
			// Always built, even with nothing stored: the arrows are paired with blocks through it,
			// and an arrow that cannot be paired is left alone (PR-5 R2), so an embed with no state
			// can still have Obsidian's own folds on paired arrows undone.
			const candidates: AnchoredBlock[] = buildAnchors(resolved.sliceText);
			const budget = this.budgetFor(host.file.path);
			const rematch = await planEmbedPass({
				record: snapshot,
				sliceHash: resolved.sliceHash,
				candidates,
				budget,
				yieldToHost: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
				matcherOptions: this.deps.matcherOptions,
				now: (this.deps.now ?? Date.now)(),
			});
			const matches = rematch.matches;

			await this.deps.whenRecorded();
			if (this.stale(el, generation)) return;
			// E3: a fold or unfold Dan made while this pass was matching wins. Start over from the
			// record as it is now, so the pass never undoes (or re-does) what he just did.
			if (recordFoldsKey(this.deps.store.getEmbed(resolved.identity)) !== recordFoldsKey(snapshot)) {
				// The outcome is thrown away and the next go pays again: give this attempt's
				// comparisons back, so one embed that keeps being clicked cannot use up the
				// budget meant for its siblings (PR-6 R8).
				budget.refund(rematch.comparisons);
				continue;
			}

			// From here to the clicks there is no await: what the arrows show is what is planned against.
			const arrows = describeArrows(el);
			const live: LiveArrow[] = arrows.map((arrow) => ({
				block: candidates.length > 0 ? blockIndexForToggle(candidates, arrow.toggle) : null,
				collapsed: arrow.indicator.classList.contains(COLLAPSED_CLASS),
			}));
			const plan = planEmbedRestore({ matches, candidates, arrows: live });
			// Out of comparison budget: some stored folds could not be placed this pass, so what the
			// embed shows is not second-guessed either. Folds that were placed are applied; nothing is
			// unfolded, and the record is not touched (E7). This is a deliberate reading of the spec's
			// "embeds that run out of budget are not folded": the folds that were placed are confident
			// matches, so applying them is safe, and only the ones that could not be placed are left
			// out (PR-6 R6).
			if (rematch.budgetExhausted) plan.unfold = [];

			// G3/G4: the slice changed and the folds were placed on it: the record now describes the
			// new slice, so a second edit matches against the latest state. No await since the check
			// above, so this cannot overwrite a fold or unfold Dan has just made (E3).
			if (rematch.update !== null) {
				const current = this.deps.store.getEmbed(resolved.identity);
				if (current !== undefined) {
					this.deps.store.setEmbed({
						...current,
						contentHash: rematch.update.contentHash,
						folds: rematch.update.folds,
						dormant: rematch.update.dormant,
					});
				}
			}
			const toClick = [...plan.fold, ...plan.unfold];
			if (toClick.length === 0) this.echoStreak.delete(el); // the embed is as stored: any echo loop is over
			else this.lastOwnClick.set(el, (this.deps.now ?? Date.now)());
			for (const i of toClick) {
				const indicator = arrows[i].indicator as HTMLElement;
				if (typeof indicator.click === "function") indicator.click();
			}
			return;
		}
		// The record kept changing: look again once things are quiet rather than fight a user.
		this.scheduleRender(el);
	}
}
