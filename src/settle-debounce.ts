/**
 * A small debounce utility purpose-built for E9: the "settled non-user change" signal the editor
 * watcher (src/editor-watcher.ts) needs. Not CM6-specific and not file/path-aware on its own —
 * just "keep resetting a 150ms timer every time trigger() is called; when it finally elapses,
 * call back with whatever payload was passed to the *last* trigger() (E9: 'the last settled text
 * wins')". `cancel()` clears a pending timer without firing it (used when the editor view this
 * instance belongs to is destroyed — E9's "unloading ... with a timer pending clears it").
 *
 * Uses `window.setTimeout`/`window.clearTimeout`, same as `FoldStore` (obsidianmd/
 * prefer-window-timers), so a timer started against one popout window's `window` is tracked
 * there, not against Obsidian's main one. The caller passes `win` explicitly for exactly that
 * reason (and so tests can use fake timers without having to install them globally).
 */
export class SettleDebouncer<T> {
	private timer: number | null = null;
	private readonly delayMs: number;
	private readonly win: Window;
	private readonly onSettle: (payload: T) => void;

	constructor(onSettle: (payload: T) => void, delayMs = 150, win: Window = window) {
		this.onSettle = onSettle;
		this.delayMs = delayMs;
		this.win = win;
	}

	/** Resets the timer; when it elapses, `onSettle` is called with this `payload` — the most
	 * recent call always wins, since each call replaces whatever was scheduled before it. */
	trigger(payload: T): void {
		this.cancel();
		this.timer = this.win.setTimeout(() => {
			this.timer = null;
			this.onSettle(payload);
		}, this.delayMs);
	}

	/** Clears any pending timer without firing it. Idempotent. */
	cancel(): void {
		if (this.timer !== null) {
			this.win.clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
