/**
 * E9's timing rules, directly against `SettleDebouncer` (src/settle-debounce.ts) with fake
 * timers — no CM6 needed here, this utility isn't CM6-specific.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettleDebouncer } from "../../src/settle-debounce";

describe("SettleDebouncer: E9 timing rules", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("five triggers 40ms apart produce exactly one settle, 150ms after the last, carrying the last payload", () => {
		const onSettle = vi.fn();
		const debouncer = new SettleDebouncer<string>(onSettle, 150);

		debouncer.trigger("text-1");
		vi.advanceTimersByTime(40);
		debouncer.trigger("text-2");
		vi.advanceTimersByTime(40);
		debouncer.trigger("text-3");
		vi.advanceTimersByTime(40);
		debouncer.trigger("text-4");
		vi.advanceTimersByTime(40);
		debouncer.trigger("text-5");

		expect(onSettle).not.toHaveBeenCalled();

		vi.advanceTimersByTime(149);
		expect(onSettle).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onSettle).toHaveBeenCalledTimes(1);
		expect(onSettle).toHaveBeenCalledWith("text-5");
	});

	it("a trigger at 149ms resets the timer (no settle yet)", () => {
		const onSettle = vi.fn();
		const debouncer = new SettleDebouncer<string>(onSettle, 150);

		debouncer.trigger("first");
		vi.advanceTimersByTime(149);
		debouncer.trigger("second");
		vi.advanceTimersByTime(149);
		expect(onSettle).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onSettle).toHaveBeenCalledTimes(1);
		expect(onSettle).toHaveBeenCalledWith("second");
	});

	it("a trigger at 151ms produces a second, separate settle event", () => {
		const onSettle = vi.fn();
		const debouncer = new SettleDebouncer<string>(onSettle, 150);

		debouncer.trigger("first");
		vi.advanceTimersByTime(151);
		expect(onSettle).toHaveBeenCalledTimes(1);
		expect(onSettle).toHaveBeenCalledWith("first");

		debouncer.trigger("second");
		vi.advanceTimersByTime(150);
		expect(onSettle).toHaveBeenCalledTimes(2);
		expect(onSettle).toHaveBeenCalledWith("second");
	});

	it("cancel() with a timer pending clears it: no event fires afterwards", () => {
		const onSettle = vi.fn();
		const debouncer = new SettleDebouncer<string>(onSettle, 150);

		debouncer.trigger("pending");
		vi.advanceTimersByTime(100);
		debouncer.cancel();
		vi.advanceTimersByTime(1000);

		expect(onSettle).not.toHaveBeenCalled();
	});

	it("cancel() with nothing pending is a harmless no-op", () => {
		const onSettle = vi.fn();
		const debouncer = new SettleDebouncer<string>(onSettle, 150);

		expect(() => debouncer.cancel()).not.toThrow();
		vi.advanceTimersByTime(1000);
		expect(onSettle).not.toHaveBeenCalled();
	});

	it("uses the injected window's setTimeout/clearTimeout, not the bare globals", () => {
		const calls: string[] = [];
		const fakeWindow = {
			setTimeout: (cb: () => void, ms: number) => {
				calls.push("setTimeout");
				return window.setTimeout(cb, ms);
			},
			clearTimeout: (id: number) => {
				calls.push("clearTimeout");
				window.clearTimeout(id);
			},
		} as unknown as Window;

		const onSettle = vi.fn();
		const debouncer = new SettleDebouncer<string>(onSettle, 150, fakeWindow);
		debouncer.trigger("a");
		debouncer.cancel();

		expect(calls).toEqual(["setTimeout", "clearTimeout"]);
	});
});
