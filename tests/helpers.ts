/** Shared test helpers for listening to the mock `Notice`'s "shown" event (see `NOTICE_EVENT` in
 * `tests/mocks/obsidian.ts`) without any obsidian-specific typing. */
import { NOTICE_EVENT } from "./mocks/obsidian";

export function collectNotices(): { messages: string[]; stop: () => void } {
	const messages: string[] = [];
	const onNotice = (evt: Event): void => {
		messages.push((evt as CustomEvent<string>).detail);
	};
	window.addEventListener(NOTICE_EVENT, onNotice);
	return { messages, stop: () => window.removeEventListener(NOTICE_EVENT, onNotice) };
}
