/**
 * Coalesces the renders of each embed (ticket warkworth-21, PR-5, E5): however many times one
 * embed renders or re-renders in a burst, one pass runs, 150 ms after the last of them, and it
 * gets the payload of that last render ("the last settled render wins"). A render that arrives
 * after the window has closed starts a new pass.
 *
 * Every key (one embed element) has its own `SettleDebouncer`, so a busy embed never holds back
 * a quiet one in a 51-embed host, and none of these timers is the store's persistence flush
 * timer (src/fold-store.ts has its own): cancelling or firing one never touches the other, and a
 * pass that is running does not delay a flush.
 *
 * Generic over the key and the payload and free of the DOM and the store, so it is unit tested
 * with fake timers.
 */
import { SettleDebouncer } from "./settle-debounce";

export const EMBED_RENDER_SETTLE_MS = 150;

export class EmbedRenderCoalescer<K, P> {
	private readonly pending = new Map<K, SettleDebouncer<P>>();
	private readonly onPass: (key: K, payload: P) => void;
	private readonly delayMs: number;
	private readonly win: Window;

	/** `onPass` runs once per settled key with the last payload. */
	constructor(onPass: (key: K, payload: P) => void, delayMs = EMBED_RENDER_SETTLE_MS, win: Window = window) {
		this.onPass = onPass;
		this.delayMs = delayMs;
		this.win = win;
	}

	/** Records a render of `key`: restarts that key's window, replacing its payload. */
	render(key: K, payload: P): void {
		let debouncer = this.pending.get(key);
		if (debouncer === undefined) {
			const created = new SettleDebouncer<P>(
				(last) => {
					// Forget the key before the pass runs, so a render during the pass starts a new window.
					if (this.pending.get(key) === created) this.pending.delete(key);
					this.onPass(key, last);
				},
				this.delayMs,
				this.win
			);
			this.pending.set(key, created);
			debouncer = created;
		}
		debouncer.trigger(payload);
	}

	/** Drops `key`'s pending pass without running it. Returns whether one was pending. */
	cancel(key: K): boolean {
		const debouncer = this.pending.get(key);
		if (debouncer === undefined) return false;
		debouncer.cancel();
		this.pending.delete(key);
		return true;
	}

	/** Drops every pending pass whose key satisfies `test` (for example, every embed inside a
	 * node that was removed from the page). Returns how many were dropped. */
	cancelWhere(test: (key: K) => boolean): number {
		let dropped = 0;
		for (const key of Array.from(this.pending.keys())) {
			if (test(key) && this.cancel(key)) dropped++;
		}
		return dropped;
	}

	cancelAll(): void {
		for (const debouncer of this.pending.values()) debouncer.cancel();
		this.pending.clear();
	}

	/** How many keys have a pass waiting. */
	get pendingCount(): number {
		return this.pending.size;
	}

	has(key: K): boolean {
		return this.pending.has(key);
	}

	/** Whether any key with a pass waiting satisfies `test`. */
	hasWhere(test: (key: K) => boolean): boolean {
		for (const key of this.pending.keys()) if (test(key)) return true;
		return false;
	}
}
