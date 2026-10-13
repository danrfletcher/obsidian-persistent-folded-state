/**
 * Hand-written stand-in for the `obsidian` package (vitest aliases it here): just enough of
 * `Plugin`, `PluginSettingTab`, `Setting`, `Modal`, `Notice` and `MarkdownView` to exercise this
 * PR's commands, settings tab and modal through real DOM behaviour (jsdom), not mocked setters.
 *
 * Fidelity notes:
 * - `Modal` closes on Escape and on a click on its own backdrop (`containerEl`), matching real
 *   Obsidian's base `Modal` so "Cancel, Escape and clicking outside" all exercise the same code
 *   path a real user would hit, not a hand-rolled substitute only this test suite understands.
 * - `Plugin.loadData`/`saveData` default to an in-memory value a test can override per instance;
 *   `tests/integration/data-json.test.ts` points them at real files instead.
 */

// --- CM6 interop (Obsidian's own StateFields, real @codemirror/state) ----------------------------
import { StateField } from "@codemirror/state";

/** Real obsidian exports `editorInfoField: StateField<MarkdownFileInfo>`; this mock defines the
 * exact same kind of field (a plain passthrough `StateField`, backed by the real
 * `@codemirror/state` package the editor watcher is also built against) so a test can set a
 * file for a given `EditorState` with `editorInfoField.init(() => ({ file }))`, the same way
 * real Obsidian wires a `MarkdownView`'s file into its CM6 state. */
export interface MockMarkdownFileInfo {
	file: { path: string; extension: string } | null;
}
export const editorInfoField = StateField.define<MockMarkdownFileInfo>({
	create: () => ({ file: null }),
	update: (value) => value,
});

// --- DOM helpers (Obsidian's HTMLElement extensions) ---------------------------------------------
interface CreateOpts {
	text?: string;
	cls?: string;
	attr?: Record<string, string>;
}

declare global {
	interface HTMLElement {
		createEl<K extends keyof HTMLElementTagNameMap>(tag: K, opts?: CreateOpts | string): HTMLElementTagNameMap[K];
		createDiv(opts?: CreateOpts | string): HTMLDivElement;
		empty(): void;
		setText(text: string): void;
		addClass(...cls: string[]): void;
		removeClass(...cls: string[]): void;
	}
}

function make(parent: HTMLElement, tag: string, opts?: CreateOpts | string): HTMLElement {
	const o: CreateOpts = typeof opts === "string" ? { cls: opts } : opts ?? {};
	const el = document.createElement(tag);
	if (o.cls) el.className = o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
	parent.appendChild(el);
	return el;
}

const proto = HTMLElement.prototype;
proto.createEl = function (tag: string, opts?: CreateOpts | string) {
	return make(this, tag, opts) as never;
};
proto.createDiv = function (opts?: CreateOpts | string) {
	return make(this, "div", opts) as HTMLDivElement;
};
proto.empty = function () {
	this.replaceChildren();
};
proto.setText = function (text: string) {
	this.textContent = text;
};
proto.addClass = function (...cls: string[]) {
	this.classList.add(...cls);
};
proto.removeClass = function (...cls: string[]) {
	this.classList.remove(...cls);
};

// --- Vault/workspace model (just enough for the forget-note-folds command) ----------------------
export class TFile {
	extension = "md";
	constructor(public path: string) {}
	get name(): string {
		return this.path.slice(this.path.lastIndexOf("/") + 1);
	}
	get basename(): string {
		const { name } = this;
		const dot = name.lastIndexOf(".");
		return dot <= 0 ? name : name.slice(0, dot);
	}
}

/** Stand-in for a non-markdown-editor view (canvas, image, ...): deliberately *not* a
 * `MarkdownView`, so `getActiveViewOfType(MarkdownView)` correctly returns null for it. */
export class OtherView {}

export class MarkdownView {
	file: TFile | null = null;
}

export class Editor {}

export class Workspace {
	private active: unknown = null;
	/** Test helper: Obsidian itself decides which view is "active" (focus, last-opened leaf,
	 * etc.); tests set it directly rather than simulating that machinery. */
	setActiveView(view: unknown): void {
		this.active = view;
	}
	getActiveViewOfType<T>(type: new (...args: never[]) => T): T | null {
		return this.active instanceof type ? (this.active as T) : null;
	}
}

export class App {
	workspace = new Workspace();
}

// --- UI --------------------------------------------------------------------------------------
/** `Notice`: every construction also dispatches a plain DOM `CustomEvent` on `window`, so a test
 * can observe "a Notice was shown" with `window.addEventListener("obsidian-mock:notice", ...)`
 * without needing any obsidian-specific typing to read it back (see `tests/helpers.ts`). */
export const NOTICE_EVENT = "obsidian-mock:notice";

export class Notice {
	constructor(public message: string) {
		window.dispatchEvent(new CustomEvent<string>(NOTICE_EVENT, { detail: message }));
	}
	hide(): void {}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
}

export class Scope {}

/** Real Obsidian's `Events` base class (used by `Vault`/`Workspace`/`MetadataCache`): `on`
 * registers a listener and returns a ref `off`/`offref` can later remove; `trigger` calls every
 * listener for that name, in registration order, catching nothing itself (a throwing listener
 * propagates, same as real Obsidian's documented "executing all the listeners in order even if
 * some of them throw" — this mock keeps that simple rather than exactly replicating the
 * async-rethrow wording, which no test here depends on). R3 (`src/main.ts`) is this PR's only
 * user: the "settled non-user change" subscription point. */
export interface EventRef {
	name: string;
	callback: (...data: unknown[]) => unknown;
}

export class Events {
	private listeners = new Map<string, Set<(...data: unknown[]) => unknown>>();

	on(name: string, callback: (...data: unknown[]) => unknown): EventRef {
		let set = this.listeners.get(name);
		if (!set) {
			set = new Set();
			this.listeners.set(name, set);
		}
		set.add(callback);
		return { name, callback };
	}
	off(name: string, callback: (...data: unknown[]) => unknown): void {
		this.listeners.get(name)?.delete(callback);
	}
	offref(ref: EventRef): void {
		this.off(ref.name, ref.callback);
	}
	trigger(name: string, ...data: unknown[]): void {
		for (const callback of this.listeners.get(name) ?? []) callback(...data);
	}
}

/** Base `Modal`: a real jsdom DOM, closing on Escape and on a backdrop click, same as real
 * Obsidian — so every subclass (just `ForgetAllFoldsModal` in this PR) gets that for free. */
export class Modal {
	app: App;
	scope = new Scope();
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;

	private readonly onKeydown = (evt: KeyboardEvent): void => {
		if (evt.key === "Escape") {
			evt.preventDefault();
			this.close();
		}
	};
	private readonly onBackdropClick = (evt: MouseEvent): void => {
		if (evt.target === this.containerEl) this.close();
	};

	constructor(app: App) {
		this.app = app;
		this.containerEl = document.createElement("div");
		this.containerEl.className = "modal-container";
		this.modalEl = this.containerEl.createDiv({ cls: "modal" });
		this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
	}

	open(): void {
		document.body.appendChild(this.containerEl);
		document.addEventListener("keydown", this.onKeydown);
		this.containerEl.addEventListener("click", this.onBackdropClick);
		this.onOpen();
	}

	close(): void {
		if (!this.containerEl.isConnected) return;
		document.removeEventListener("keydown", this.onKeydown);
		this.containerEl.removeEventListener("click", this.onBackdropClick);
		this.containerEl.remove();
		this.onClose();
	}

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}
	setContent(content: string): this {
		this.contentEl.setText(content);
		return this;
	}

	onOpen(): void {}
	onClose(): void {}
}

export class BaseComponent {
	disabled = false;
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
}

export class ButtonComponent extends BaseComponent {
	buttonEl: HTMLButtonElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.buttonEl = containerEl.createEl("button") as HTMLButtonElement;
	}
	setCta(): this {
		this.buttonEl.classList.add("mod-cta");
		return this;
	}
	removeCta(): this {
		this.buttonEl.classList.remove("mod-cta");
		return this;
	}
	setWarning(): this {
		this.buttonEl.classList.add("mod-warning");
		return this;
	}
	setDestructive(): this {
		this.buttonEl.classList.add("mod-destructive");
		return this;
	}
	setButtonText(name: string): this {
		this.buttonEl.textContent = name;
		return this;
	}
	setIcon(_icon: string): this {
		return this;
	}
	setTooltip(_tooltip: string): this {
		return this;
	}
	setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.buttonEl.disabled = disabled;
		return this;
	}
	onClick(callback: (evt: MouseEvent) => void): this {
		this.buttonEl.addEventListener("click", (evt) => {
			if (!this.disabled) callback(evt);
		});
		return this;
	}
}

/** `Setting`: builds the same `setting-item` DOM structure as real Obsidian, so a test can assert
 * "exactly one control" with a plain DOM query instead of inspecting internal plugin state. */
export class Setting {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	components: BaseComponent[] = [];

	constructor(public containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: "setting-item" });
		this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
		this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
		this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
		this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
	}
	setName(name: string): this {
		this.nameEl.setText(name);
		return this;
	}
	setDesc(desc: string): this {
		this.descEl.setText(desc);
		return this;
	}
	setClass(cls: string): this {
		this.settingEl.addClass(cls);
		return this;
	}
	setHeading(): this {
		this.settingEl.addClass("setting-item-heading");
		return this;
	}
	setDisabled(disabled: boolean): this {
		for (const component of this.components) component.setDisabled(disabled);
		return this;
	}
	addButton(cb: (component: ButtonComponent) => unknown): this {
		const button = new ButtonComponent(this.controlEl);
		this.components.push(button);
		cb(button);
		return this;
	}
}

export interface Command {
	id: string;
	name: string;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
	editorCallback?: (...args: unknown[]) => unknown;
	editorCheckCallback?: (checking: boolean, ...args: unknown[]) => boolean | void;
}

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description: string;
	author: string;
	isDesktopOnly: boolean;
}

type DomListener = { el: EventTarget; type: string; cb: EventListenerOrEventListenerObject };

/** Base `Plugin`: enough lifecycle (`loadData`/`saveData`, `addCommand`, `addSettingTab`,
 * `registerDomEvent`, `unload`) for `main.ts` and for a test to exercise exactly what disabling
 * the plugin in Obsidian does (`unload()` runs `onunload()`, then detaches every
 * `registerDomEvent` listener) without duplicating that bookkeeping in the plugin's own code. */
export class Plugin {
	app: App;
	manifest: PluginManifest;
	private commands: Command[] = [];
	private settingTabs: PluginSettingTab[] = [];
	private domListeners: DomListener[] = [];
	private storedData: unknown = null;

	constructor(app: App, manifest: PluginManifest) {
		this.app = app;
		this.manifest = manifest;
	}

	async loadData(): Promise<unknown> {
		return this.storedData;
	}
	async saveData(data: unknown): Promise<void> {
		this.storedData = data;
	}

	addCommand(command: Command): Command {
		this.commands.push(command);
		return command;
	}
	removeCommand(id: string): void {
		this.commands = this.commands.filter((command) => command.id !== id);
	}
	getCommands(): Command[] {
		return this.commands;
	}

	addSettingTab(tab: PluginSettingTab): void {
		this.settingTabs.push(tab);
	}
	getSettingTabs(): PluginSettingTab[] {
		return this.settingTabs;
	}

	registerDomEvent(el: EventTarget, type: string, cb: EventListenerOrEventListenerObject): void {
		el.addEventListener(type, cb);
		this.domListeners.push({ el, type, cb });
	}

	/** Real Obsidian applies the extension to every open (and later-opened) CM6 editor and tears
	 * it back out on unload; this mock only needs to not throw when `onload()` calls it — the
	 * editor-watcher's own CM6-level tests exercise the extension directly against a real
	 * `EditorState`/`EditorView`, which is where its actual attach/detach behaviour is proven. */
	registerEditorExtension(_extension: unknown): void {}

	/** Real Obsidian's own `Component.unload()`: called when the plugin is disabled. Runs
	 * `onunload()`, then detaches every `registerDomEvent` listener (E7/E12: "gone after
	 * unload") — the plugin author never has to do that bookkeeping themselves. */
	unload(): void {
		this.onunload();
		for (const { el, type, cb } of this.domListeners) el.removeEventListener(type, cb);
		this.domListeners = [];
	}

	async onload(): Promise<void> {}
	onunload(): void {}
}

export class PluginSettingTab {
	app: App;
	containerEl: HTMLElement;
	constructor(app: App, _plugin: Plugin) {
		this.app = app;
		this.containerEl = document.createElement("div");
	}
	display(): void {}
	hide(): void {}
}
