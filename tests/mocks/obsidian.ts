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

/** Real Obsidian's `Events` base class (used by `Vault`/`Workspace`/`MetadataCache`): `on`
 * registers a listener and returns a ref `off`/`offref` can later remove; `trigger` calls every
 * listener for that name, in registration order, catching nothing itself (a throwing listener
 * propagates, same as real Obsidian's documented "executing all the listeners in order even if
 * some of them throw" — this mock keeps that simple rather than exactly replicating the
 * async-rethrow wording, which no test here depends on). R3 (`src/main.ts`) is this PR's only
 * user: the "settled non-user change" subscription point. Declared here, ahead of `Vault` and
 * `Workspace` (PR-7), since both now `extends Events`. */
export interface EventRef {
	name: string;
	callback: (...data: unknown[]) => unknown;
	/** The `Events` instance `on()` was called against — real Obsidian's `EventRef` carries
	 * this too (opaquely); `Plugin.registerEvent` (below) uses it to call `offref` on exactly
	 * the right object at unload, without having to be told which one up front. */
	source: Events;
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
		return { name, callback, source: this };
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

/** PR-7 (G8, open restore): real Obsidian's own CM5/CM6 bridge (`obsidian.d.ts`'s `Editor`) has
 * no *public, typed* way to reach the underlying CM6 `EditorView` — `src/main.ts`'s own
 * `file-open` handler reaches it via the same `(editor as unknown as { cm?: EditorView })`
 * pattern the wider Obsidian plugin community uses, since there is no supported alternative.
 * This mock models exactly that shape: a plain holder for whatever `EditorView` a test
 * constructed directly (same `makeView`/`makePaneView` helpers every other CM6-level test here
 * already uses), rather than a real CM5/CM6 bridge object. */
export class Editor {
	constructor(public cm?: unknown) {}
}

/** The DOM shape a real `MarkdownView` keeps (proven by scripts/e2e-embed-probe.mjs): both
 * surfaces live under `containerEl`, and the one that does not match the current mode is hidden,
 * not removed. */
export function buildViewContainer(doc: Document = document): HTMLElement {
	const containerEl = doc.createElement("div");
	containerEl.className = "workspace-leaf-content";
	const content = doc.createElement("div");
	content.className = "view-content";
	const sourceView = doc.createElement("div");
	sourceView.className = "markdown-source-view cm-s-obsidian mod-cm6";
	const readingView = doc.createElement("div");
	readingView.className = "markdown-reading-view";
	content.append(sourceView, readingView);
	containerEl.append(content);
	return containerEl;
}

export class MarkdownView {
	file: TFile | null = null;
	editor?: Editor;
	/** Real `MarkdownView.getMode()` returns "source" (Source mode and Live Preview alike) or
	 * "preview" (Reading view). A test sets `mode` directly. */
	mode: "source" | "preview" = "source";
	/** Real `getState().source` is true in Source mode and false in Live Preview (both report
	 * `getMode() === "source"`). A test sets it directly. */
	sourceMode = false;
	/** Real `MarkdownView.containerEl`; a test appends embed elements to `sourceSurface()` or
	 * `readingSurface()`. A pop-out window pane passes a `Document` from another window. */
	containerEl: HTMLElement;
	constructor(doc: Document = document) {
		this.containerEl = buildViewContainer(doc);
	}
	getMode(): "source" | "preview" {
		return this.mode;
	}
	getViewType(): string {
		return "markdown";
	}
	getState(): Record<string, unknown> {
		return { file: this.file?.path, mode: this.mode, source: this.sourceMode };
	}
	/** Real `TextFileView.data` / `getViewData()`: the note's current text. A test sets `data`. */
	data = "";
	getViewData(): string {
		return this.data;
	}
	sourceSurface(): HTMLElement {
		return this.containerEl.querySelector(".markdown-source-view") as HTMLElement;
	}
	readingSurface(): HTMLElement {
		return this.containerEl.querySelector(".markdown-reading-view") as HTMLElement;
	}
}

/** A canvas / graph / image style view: a workspace leaf's view that is deliberately not a
 * `MarkdownView`, but has its own `containerEl` (a canvas card's embedded markdown lives in it). */
export class CanvasLikeView {
	containerEl: HTMLElement;
	constructor(
		private readonly type = "canvas",
		doc: Document = document
	) {
		this.containerEl = doc.createElement("div");
		this.containerEl.className = "workspace-leaf-content";
	}
	getViewType(): string {
		return this.type;
	}
}

/** A hover popover / page preview: real Obsidian appends `.hover-popover` to the document body,
 * outside every workspace leaf. Its embeds are not workspace Markdown views. */
export function buildHoverPopover(doc: Document = document): HTMLElement {
	const popover = doc.createElement("div");
	popover.className = "popover hover-popover";
	doc.body.append(popover);
	return popover;
}

/** A fake in-memory `DataAdapter` with the four calls the diagnostic log uses (warkworth-46
 * PR-1): `exists`, `read`, `write` and `append`. Files live in a `Map`. `read` of a missing file
 * rejects, as the real adapter does; `append` to a missing file creates it. Test hooks make a
 * call reject (`failWith`), throw synchronously (`throwSync`) or never settle (`hang`), and
 * `calls` records every call in order. */
export class MemoryAdapter {
	readonly files = new Map<string, string>();
	readonly calls: { method: "exists" | "read" | "write" | "append"; path: string }[] = [];
	/** When set, `write` and `append` reject with this. */
	failWith: unknown = undefined;
	/** When true, `write` and `append` throw before returning a promise. */
	throwSync = false;
	/** When true, `write` and `append` return a promise that never settles. */
	hang = false;
	/** When set, `read` rejects with this (an existing file that cannot be read). */
	readFailWith: unknown = undefined;
	/** Warkworth-46 PR-2: where `read` looks for a note that is not one of `files` (the plugin's
	 * own log). The vault points it at the same `contents` map `setContent` fills. */
	noteText: (path: string) => string | undefined = () => undefined;
	/** Warkworth-46 PR-2: paths whose `read` rejects with the error given (a note that cannot be
	 * read), set through `Vault.failReadsOf`. */
	readonly failingReads = new Map<string, unknown>();

	exists(path: string): Promise<boolean> {
		this.calls.push({ method: "exists", path });
		return Promise.resolve(this.files.has(path));
	}
	read(path: string): Promise<string> {
		this.calls.push({ method: "read", path });
		if (this.readFailWith !== undefined) return Promise.reject(this.readFailWith);
		if (this.failingReads.has(path)) return Promise.reject(this.failingReads.get(path));
		const text = this.files.get(path) ?? this.noteText(path);
		return text === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(text);
	}
	/** Warkworth-46 PR-3: the real adapter's `stat`: `{ size }` in bytes for a file, null for none. */
	stat(path: string): Promise<{ size: number } | null> {
		const text = this.files.get(path) ?? this.noteText(path);
		return Promise.resolve(text === undefined ? null : { size: new TextEncoder().encode(text).length });
	}
	write(path: string, data: string): Promise<void> {
		this.calls.push({ method: "write", path });
		return this.mutate(() => void this.files.set(path, data));
	}
	append(path: string, data: string): Promise<void> {
		this.calls.push({ method: "append", path });
		return this.mutate(() => void this.files.set(path, (this.files.get(path) ?? "") + data));
	}
	private mutate(apply: () => void): Promise<void> {
		if (this.throwSync) throw new Error("adapter threw synchronously");
		if (this.hang) return new Promise<void>(() => {});
		if (this.failWith !== undefined) return Promise.reject(this.failWith);
		apply();
		return Promise.resolve();
	}
}

/** Just enough of real Obsidian's `Vault` (PR-7, G9/G10) to exercise `app.vault.on("rename"/
 * "delete", ...)` and `getAbstractFileByPath`: extends `Events` (declared just above), so
 * `vault.on(...)`/`vault.trigger(...)` behave exactly like every other Obsidian event (same
 * rationale as `src/main.ts`'s own `events` — see that file's R3 comment). `getAbstractFileByPath`
 * is backed by a plain `Set` a test seeds directly with `setExists` (rather than a real
 * filesystem) — Obsidian itself decides what's actually in the vault; this mock only needs to
 * answer "does this path exist" the way `main.ts`'s own `pruneOrphans` call asks it to. */
export class Vault extends Events {
	/** Real `Vault.adapter`: the in-memory stand-in below (warkworth-46 PR-1: the diagnostic log). */
	adapter = new MemoryAdapter();
	constructor() {
		super();
		this.adapter.noteText = (path) => this.contents.get(path);
	}
	/** Real `Vault.configDir`. */
	configDir = ".obsidian";
	private paths = new Set<string>();

	getAbstractFileByPath(path: string): TFile | null {
		return this.paths.has(path) ? new TFile(path) : null;
	}
	/** Test helper: marks `path` as existing in the vault (or not), independent of ever calling
	 * `trigger("rename"/"delete", ...)` — a test drives those two separately so it can exercise
	 * "the listener ran but the path still/no-longer exists" however it needs to. */
	setExists(path: string, exists = true): void {
		if (exists) this.paths.add(path);
		else this.paths.delete(path);
	}

	private contents = new Map<string, string>();
	/** Test helper: a note that exists and has this text (what `cachedRead` returns). */
	setContent(path: string, text: string): void {
		this.paths.add(path);
		this.contents.set(path, text);
	}
	/** Warkworth-46 PR-2: true when `setContent` has given `path` a text. */
	hasContent(path: string): boolean {
		return this.contents.has(path);
	}
	/** Warkworth-46 PR-2: the note's text goes away (as if the file were deleted from disk): the
	 * adapter's `read` of it rejects, as the real one does for a missing file. */
	removeContent(path: string): void {
		this.contents.delete(path);
	}
	/** Warkworth-46 PR-2: makes the adapter's `read` of `path` reject with `error` (a note that
	 * exists but cannot be read). `restoreReads` undoes it. */
	failReadsOf(path: string, error: unknown = new Error("EIO: read failed")): void {
		this.adapter.failingReads.set(path, error);
	}
	restoreReads(path: string): void {
		this.adapter.failingReads.delete(path);
	}
	/** Every path a test has told this vault about. */
	allPaths(): string[] {
		return [...this.paths];
	}
	/** Real `Vault.getFileByPath`: the file, or null. */
	getFileByPath(path: string): TFile | null {
		return this.paths.has(path) ? new TFile(path) : null;
	}
	/** Real `Vault.cachedRead`: read-only; "" for a note with no text set. */
	async cachedRead(file: TFile): Promise<string> {
		return this.contents.get(file.path) ?? "";
	}
}

/** Just enough of real `MetadataCache`: `getFirstLinkpathDest` (an exact path, with or without
 * `.md`, else the first note whose name matches, else null; ignores the source path), the `Events`
 * base (so `metadataCache.on("changed", ...)` and `trigger("changed", file, data, cache)` behave as
 * in Obsidian) and `getFileCache` over caches a test sets with `setCache`. */
export interface MockCachedMetadata {
	headings?: { heading: string; level: number }[];
	embeds?: { link: string }[];
}

export class MetadataCache extends Events {
	private caches = new Map<string, MockCachedMetadata>();
	constructor(private readonly vault: Vault) {
		super();
	}
	/** Test helper: the cache `getFileCache` answers for `path`. */
	setCache(path: string, cache: MockCachedMetadata): void {
		this.caches.set(path, cache);
	}
	getFileCache(file: TFile): MockCachedMetadata | null {
		return this.caches.get(file.path) ?? null;
	}
	getFirstLinkpathDest(linkpath: string, _sourcePath: string): TFile | null {
		const wanted = linkpath.replace(/\.md$/i, "");
		for (const path of this.vault.allPaths()) {
			const bare = path.replace(/\.md$/i, "");
			if (bare === wanted || bare.slice(bare.lastIndexOf("/") + 1) === wanted) return new TFile(path);
		}
		return null;
	}
}

/** PR-7 adds `extends Events` (real Obsidian's `Workspace` does too) so `on("file-open", ...)`/
 * `trigger("file-open", ...)` work the same way every other Obsidian event in this mock does,
 * and `activeEditor` (real Obsidian's own `Workspace.activeEditor`, a public getter — see
 * obsidian.d.ts), derived from whichever view `setActiveView` was last given, the same "tests
 * set it directly" rationale as `getActiveViewOfType`. */
export class Workspace extends Events {
	private active: unknown = null;
	private leaves: { view: unknown }[] = [];
	/** Test helper: opens a leaf holding `view`, in the order real `iterateAllLeaves` would visit. */
	addLeaf(view: unknown): { view: unknown } {
		const leaf = { view };
		this.leaves.push(leaf);
		return leaf;
	}
	/** Real Obsidian's `Workspace.iterateAllLeaves` (main area, sidebars and pop-out windows). */
	iterateAllLeaves(callback: (leaf: { view: unknown }) => unknown): void {
		for (const leaf of [...this.leaves]) callback(leaf);
	}
	/** PR-7 (R1): starts `false` — unlike real Obsidian (where layout readiness depends on the
	 * app's own startup sequence, already finished long before most tests' synchronous setup
	 * runs), a test here must opt in to "layout is ready" explicitly via `triggerLayoutReady`,
	 * so a test can assert what happens (nothing) before that moment too. */
	private layoutIsReady = false;
	private layoutReadyCallbacks: (() => void)[] = [];
	/** Test helper: Obsidian itself decides which view is "active" (focus, last-opened leaf,
	 * etc.); tests set it directly rather than simulating that machinery. */
	setActiveView(view: unknown): void {
		this.active = view;
	}
	getActiveViewOfType<T>(type: new (...args: never[]) => T): T | null {
		return this.active instanceof type ? (this.active as T) : null;
	}
	get activeEditor(): { file: TFile | null; editor?: Editor } | null {
		return this.active instanceof MarkdownView ? { file: this.active.file, editor: this.active.editor } : null;
	}
	/** T2: real Obsidian's `registerEditorExtension` only updates the plugin's own extension
	 * array — per obsidian.d.ts's own doc comment, applying that change to every already-open
	 * editor requires an explicit `Workspace.updateOptions()` call. The mock is a no-op spy
	 * target: tests assert it was actually called, since nothing here can simulate a real CM6
	 * reconfigure of an already-open pane. */
	updateOptions(): void {}
	/** PR-7 (R1): real Obsidian's own `Workspace.onLayoutReady` — calls `callback` immediately
	 * if the app's startup sequence has already finished populating the vault's file tree by
	 * the time this is called, or queues it for whenever `triggerLayoutReady` says that happened.
	 * `main.ts`'s own `onload()` defers `pruneOrphans` through this, rather than running it right
	 * after `store.load()`, because `getAbstractFileByPath` can still answer `null` for a file
	 * that genuinely exists until that moment (see that file's own R1 comment). */
	onLayoutReady(callback: () => void): void {
		if (this.layoutIsReady) callback();
		else this.layoutReadyCallbacks.push(callback);
	}
	/** Test helper: fires every `onLayoutReady` callback queued so far (and any registered
	 * after, immediately) — simulating the one moment real Obsidian's own startup sequence
	 * reaches "layout ready". Idempotent: a second call is a no-op. */
	triggerLayoutReady(): void {
		if (this.layoutIsReady) return;
		this.layoutIsReady = true;
		const callbacks = this.layoutReadyCallbacks;
		this.layoutReadyCallbacks = [];
		for (const callback of callbacks) callback();
	}
}

export class App {
	workspace = new Workspace();
	vault = new Vault();
	metadataCache = new MetadataCache(this.vault);
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
	private eventRefs: EventRef[] = [];
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

	/** Real Obsidian's own `Component.registerEvent`: tracked here (rather than immediately
	 * `offref`'d) so `unload()` below can detach it automatically, same as `registerDomEvent`'s
	 * own listeners (E7/E12: "gone after unload") — `main.ts`'s PR-7 rename/delete listeners
	 * rely on this. */
	registerEvent(eventRef: EventRef): void {
		this.eventRefs.push(eventRef);
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
		for (const ref of this.eventRefs) ref.source.offref(ref);
		this.eventRefs = [];
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
