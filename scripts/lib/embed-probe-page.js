/**
 * In-page half of scripts/e2e-embed-probe.mjs: evaluated once per CDP connection inside the
 * running Obsidian window (it needs `app`, `document`, `MutationObserver`). It only observes and
 * clicks fold toggles the way a user would; it is a test script, never plugin code, and nothing
 * here ships in main.js. Every function returns plain JSON-serialisable data.
 *
 * Observation model (what the probe learned about Obsidian 1.14, kept here as the reading guide):
 *  - A note embed is `.internal-embed.markdown-embed` (a `div` in Live Preview and Reading view,
 *    a `span` for a nested one); image embeds carry `image-embed`/`media-embed` instead.
 *  - Its content is a reading-view style render: list items get a `.list-collapse-indicator`,
 *    headings a `.heading-collapse-indicator`; collapsed = `is-collapsed` on the indicator and on
 *    its owner (`li`/heading).
 */
(function () {
	if (window.__pfsEmbedProbe) for (const name of Object.keys(window.__pfsEmbedProbe.recorders || {})) window.__pfsEmbedProbe.stopRecorder(name);

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const now = () => performance.now();
	const round = (n) => Math.round(n * 10) / 10;

	// ---- leaves and DOM helpers -------------------------------------------------------------
	/** Every Markdown leaf. Obsidian 1.1.44's iterateAllLeaves skips tabs that are not the active one
	 * in their group, so the probe asks for the Markdown leaves directly. */
	function allMarkdownLeaves() {
		return app.workspace.getLeavesOfType("markdown").filter((leaf) => leaf.view && leaf.view.file);
	}

	function markdownLeavesFor(path) {
		return allMarkdownLeaves().filter((leaf) => leaf.view.file.path === path);
	}

	function viewFor(path) {
		const leaves = markdownLeavesFor(path);
		return leaves.length ? leaves[leaves.length - 1].view : null;
	}

	function closeLeavesFor(path) {
		const leaves = markdownLeavesFor(path);
		for (const leaf of leaves) leaf.detach();
		return leaves.length;
	}

	function closeProbeLeaves(prefix) {
		const leaves = allMarkdownLeaves().filter((leaf) => leaf.view.file.path.startsWith(prefix));
		for (const leaf of leaves) leaf.detach();
		return leaves.length;
	}

	/** A MarkdownView keeps both surfaces in the DOM and hides the inactive one: a Reading view
	 * still contains the (hidden) Live Preview editor and its unrendered embeds, and vice versa. Only
	 * the surface that matches the view's mode is the visible host. */
	function surfaceOf(view) {
		return view.containerEl.querySelector(view.getMode() === "preview" ? ".markdown-reading-view" : ".markdown-source-view") || view.containerEl;
	}

	function isTopLevelEmbed(el) {
		return !el.parentElement || !el.parentElement.closest(".internal-embed");
	}

	function topEmbeds(root) {
		return [...root.querySelectorAll(".internal-embed")].filter(isTopLevelEmbed);
	}

	function embedKeyOf(el, root) {
		const src = el.getAttribute("src");
		const same = topEmbeds(root).filter((e) => e.getAttribute("src") === src);
		return src + "|" + same.indexOf(el);
	}

	function ownLabel(owner) {
		if (!owner) return "";
		if (/^H[1-6]$/.test(owner.tagName)) return owner.textContent.trim();
		let text = "";
		for (const node of owner.childNodes) if (node.nodeType === 3) text += node.textContent;
		return text.trim();
	}

	function togglesOf(embed) {
		const found = [...embed.querySelectorAll(".collapse-indicator")].filter(
			(t) => !t.closest(".metadata-container") && t.closest(".internal-embed") === embed
		);
		return found.map((t, index) => {
			const owner = t.closest("li, h1, h2, h3, h4, h5, h6");
			let childrenHidden = null;
			if (owner && owner.tagName === "LI") {
				const lists = [...owner.children].filter((c) => c.tagName === "UL" || c.tagName === "OL");
				childrenHidden = lists.length ? lists.every((l) => getComputedStyle(l).display === "none") : null;
			}
			return {
				index,
				type: t.classList.contains("heading-collapse-indicator") ? "heading" : "list",
				label: ownLabel(owner),
				collapsed: t.classList.contains("is-collapsed"),
				ownerCollapsed: owner ? owner.classList.contains("is-collapsed") : null,
				childrenHidden,
			};
		});
	}

	function isRendered(embed) {
		const content = embed.querySelector(".markdown-embed-content");
		if (content) return content.children.length > 0 && embed.classList.contains("is-loaded");
		return embed.classList.contains("is-loaded");
	}

	/** Mirrors src/embed-host.ts's container rule for the probe's report (the plugin's own module
	 * is covered by the vitest suites; this is the in-page equivalent). */
	function containerRule(el) {
		if (!el.closest(".internal-embed.markdown-embed")) return null; // media embeds are never hosts
		for (const leaf of allMarkdownLeaves()) {
			const view = leaf.view;
			if (!surfaceOf(view).contains(el)) continue;
			const mode = view.getMode() === "preview" ? "reading-view" : view.getState().source ? "source" : "live-preview";
			return { file: view.file.path, mode };
		}
		return null;
	}

	function snapshot(path) {
		const view = viewFor(path);
		if (!view) return { error: "host is not open" };
		const root = surfaceOf(view);
		const embeds = topEmbeds(root).map((el, index) => ({
			index,
			key: embedKeyOf(el, root),
			src: el.getAttribute("src"),
			tag: el.tagName.toLowerCase(),
			classes: [...el.classList],
			dataType: el.getAttribute("data-type"),
			isNoteEmbed: el.classList.contains("markdown-embed"),
			loaded: el.classList.contains("is-loaded"),
			rendered: isRendered(el),
			nestedEmbeds: el.querySelectorAll(".internal-embed").length,
			detected: containerRule(el),
			toggles: togglesOf(el),
		}));
		return {
			mode: view.getMode(),
			source: view.getState().source,
			bodyIsEmbedHost: false,
			embeds,
		};
	}

	// ---- render / re-render recorder ----------------------------------------------------------
	const recorders = {};

	function stopRecorder(name) {
		if (recorders[name]) {
			recorders[name].mo.disconnect();
			delete recorders[name];
		}
	}

	function startRecorder(name, root, leaf) {
		stopRecorder(name);
		const rec = { name, t0: now(), last: now(), events: [], ids: new Map(), ords: new Map(), nextId: 1 };
		const log = (kind, el) => {
			if (leaf && leaf.view && leaf.view.getMode) {
				const hiddenSurface = leaf.view.getMode() === "preview" ? ".markdown-source-view" : ".markdown-reading-view";
				if (el.closest(hiddenSurface)) return;
			}
			const t = now() - rec.t0;
			rec.last = now();
			if (!rec.ids.has(el)) rec.ids.set(el, rec.nextId++);
			const src = el.getAttribute("src");
			if (el.isConnected) {
				const base = leaf && leaf.view && leaf.view.getMode ? surfaceOf(leaf.view) : root;
				const same = topEmbeds(base).filter((e) => e.getAttribute("src") === src);
				rec.ords.set(el, same.indexOf(el));
			}
			const ord = rec.ords.has(el) ? rec.ords.get(el) : -1;
			rec.events.push({ t, kind, key: src + "|" + ord, elId: rec.ids.get(el), loaded: el.classList.contains("is-loaded") });
		};
		const eachTopEmbed = (node, cb) => {
			if (node.nodeType !== 1) return;
			if (node.matches(".internal-embed") && isTopLevelEmbed(node)) cb(node);
			else for (const e of node.querySelectorAll(".internal-embed")) if (isTopLevelEmbed(e)) cb(e);
		};
		const mo = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.type === "attributes") {
					const t = m.target;
					const was = (m.oldValue || "").split(" ").includes("is-loaded");
					if (t.classList.contains("internal-embed") && isTopLevelEmbed(t) && t.classList.contains("is-loaded") && !was) log("loaded", t);
					continue;
				}
				for (const n of m.addedNodes) eachTopEmbed(n, (e) => log("added", e));
				for (const n of m.removedNodes) eachTopEmbed(n, (e) => log("removed", e));
				const host = m.target.nodeType === 1 ? m.target : m.target.parentElement;
				const outer = host && host.closest && host.closest(".internal-embed");
				if (outer) {
					let top = outer;
					while (top.parentElement && top.parentElement.closest(".internal-embed")) top = top.parentElement.closest(".internal-embed");
					log("content", top);
				}
			}
		});
		mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
		rec.mo = mo;
		recorders[name] = rec;
		return rec;
	}

	/** Starts a recorder on the (already open) leaf showing `path`, e.g. to watch a source edit. */
	function recordHost(name, path) {
		const leaves = markdownLeavesFor(path);
		if (!leaves.length) throw new Error("host is not open: " + path);
		startRecorder(name, leaves[leaves.length - 1].containerEl, leaves[leaves.length - 1]);
		return name;
	}

	async function waitQuiet(name, quietMs, maxMs) {
		const rec = recorders[name];
		const start = now();
		while (now() - start < maxMs) {
			if (now() - rec.last >= quietMs) return { quiet: true, waitedMs: round(now() - start) };
			await sleep(50);
		}
		return { quiet: false, waitedMs: round(now() - start) };
	}

	function summarize(name, gapMs) {
		const rec = recorders[name];
		if (!rec) return { error: "no recorder " + name };
		const byKey = {};
		for (const e of rec.events) (byKey[e.key] = byKey[e.key] || []).push(e);
		const out = {};
		for (const [key, evs] of Object.entries(byKey)) {
			const bursts = [];
			for (const e of evs) {
				const b = bursts[bursts.length - 1];
				if (b && e.t - b.endMs <= gapMs) {
					b.endMs = round(e.t);
					b.events++;
				} else bursts.push({ startMs: round(e.t), endMs: round(e.t), events: 1 });
			}
			const loaded = evs.find((e) => e.kind === "loaded" || e.loaded);
			out[key] = {
				firstEventMs: round(evs[0].t),
				loadedMs: loaded ? round(loaded.t) : null,
				firstRenderSettledMs: bursts[0].endMs,
				bursts: bursts.length,
				rerenders: bursts.length - 1,
				burstStartsMs: bursts.map((b) => b.startMs),
				replacedElements: new Set(evs.map((e) => e.elId)).size - 1,
				events: evs.length,
			};
		}
		return out;
	}

	/** A fresh tab in the main area. After the last probe tab closes, Obsidian's active leaf can be a
	 * detached one ("No tab group found"), so anchor on any root-split leaf first. */
	function newLeaf() {
		for (const leaf of allMarkdownLeaves()) {
			app.workspace.setActiveLeaf(leaf);
			break;
		}
		try {
			return app.workspace.getLeaf("tab");
		} catch {
			// "No tab group found": the active leaf is not in the main area, so create in the root split.
			return app.workspace.createLeafInParent(app.workspace.rootSplit, 0);
		}
	}

	// ---- opening / closing hosts ----------------------------------------------------------------
	async function openHost(path, mode) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!file) throw new Error("no such file in the vault: " + path);
		closeLeavesFor(path);
		const leaf = newLeaf();
		const name = path + "|" + mode;
		startRecorder(name, leaf.containerEl, leaf);
		const t = now();
		await leaf.setViewState({
			type: "markdown",
			state: { file: path, mode: mode === "rv" ? "preview" : "source", source: false },
			active: true,
		});
		app.workspace.setActiveLeaf(leaf, { focus: true });
		const openedMs = round(now() - t);
		const quiet = await waitQuiet(name, 700, 12000);
		return { recorder: name, openedMs, quiet, viewMode: leaf.view.getMode(), source: leaf.view.getState().source };
	}

	async function openPlain(path, mode) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!file) throw new Error("no such file in the vault: " + path);
		closeLeavesFor(path);
		const leaf = newLeaf();
		await leaf.setViewState({
			type: "markdown",
			state: { file: path, mode: mode === "rv" ? "preview" : "source", source: false },
			active: true,
		});
		app.workspace.setActiveLeaf(leaf, { focus: true });
		await sleep(1200);
		return { viewMode: leaf.view.getMode(), source: leaf.view.getState().source };
	}

	// ---- toggles: locate, arm an event log, click ---------------------------------------------
	function findToggle(path, key, label) {
		const view = viewFor(path);
		if (!view) throw new Error("host is not open");
		const root = surfaceOf(view);
		const embed = topEmbeds(root).find((e) => embedKeyOf(e, root) === key);
		if (!embed) throw new Error("no embed with key " + key);
		const toggles = [...embed.querySelectorAll(".collapse-indicator")].filter(
			(t) => !t.closest(".metadata-container") && t.closest(".internal-embed") === embed
		);
		const toggle = toggles.find((t) => ownLabel(t.closest("li, h1, h2, h3, h4, h5, h6")).startsWith(label));
		if (!toggle) throw new Error('no toggle labelled "' + label + '" in ' + key);
		return { embed, toggle };
	}

	function rectOf(path, key, label) {
		const { toggle } = findToggle(path, key, label);
		toggle.scrollIntoView({ block: "center" });
		const r = toggle.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
	}

	const EVENT_TYPES = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "contextmenu", "keydown", "toggle", "fold", "unfold"];
	let eventLog = [];
	let eventCleanup = null;

	function armEvents(path, key) {
		disarmEvents();
		eventLog = [];
		const view = viewFor(path);
		const root = surfaceOf(view);
		const embed = topEmbeds(root).find((e) => embedKeyOf(e, root) === key);
		const handlers = EVENT_TYPES.map((type) => {
			const h = (ev) =>
				eventLog.push({
					type: ev.type,
					isTrusted: ev.isTrusted,
					target: (ev.target.tagName || "").toLowerCase() + "." + String(ev.target.className).split(" ").filter(Boolean).slice(0, 3).join("."),
					currentTarget: "embed",
				});
			embed.addEventListener(type, h, true);
			return [type, h];
		});
		const attrLog = new MutationObserver((ms) => {
			for (const m of ms) eventLog.push({ type: "class-mutation", isTrusted: null, target: (m.target.tagName || "").toLowerCase() + "." + String(m.target.className).split(" ").filter(Boolean).slice(-1)[0], currentTarget: "mutation" });
		});
		attrLog.observe(embed, { subtree: true, attributes: true, attributeFilter: ["class"] });
		eventCleanup = () => {
			for (const [type, h] of handlers) embed.removeEventListener(type, h, true);
			attrLog.disconnect();
		};
		return true;
	}

	function disarmEvents() {
		if (eventCleanup) eventCleanup();
		eventCleanup = null;
	}

	function readEvents() {
		const out = eventLog.slice();
		return out;
	}

	function toggleState(path, key, label) {
		const { toggle } = findToggle(path, key, label);
		const owner = toggle.closest("li, h1, h2, h3, h4, h5, h6");
		const t = togglesOf(toggle.closest(".internal-embed")).find((x) => x.label.startsWith(label));
		return { collapsed: toggle.classList.contains("is-collapsed"), ownerCollapsed: owner.classList.contains("is-collapsed"), childrenHidden: t ? t.childrenHidden : null };
	}

	function syntheticClick(path, key, label) {
		const { toggle } = findToggle(path, key, label);
		toggle.click();
		return true;
	}

	// ---- Obsidian's own fold memory (localStorage) -------------------------------------------------
	function foldKeys() {
		const out = {};
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (/-note-fold-/.test(k) && k.includes("embed-probe/")) out[k] = localStorage.getItem(k);
		}
		return out;
	}

	function clearFoldKeys() {
		let n = 0;
		for (const k of Object.keys(foldKeys())) {
			localStorage.removeItem(k);
			n++;
		}
		return n;
	}

	/** Fold state of the item a kind folded, in the note opened on its own (not as an embed).
	 * `spec` = { type: "list" | "heading", label, childText }: the item whose own text starts with
	 * `label` (a list item, or a heading whose whole text is `label`) and a line under it.
	 * Reading view reads the collapse indicator; Live Preview reads whether the folded children are
	 * still rendered as editor lines. `found: false` / `collapsed: null` means "could not tell". */
	function sourceNoteState(path, spec) {
		const view = viewFor(path);
		if (!view) return { error: "note is not open" };
		const isHeading = spec.type === "heading";
		if (view.getMode() === "preview") {
			const root = surfaceOf(view);
			const owner = isHeading
				? [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].find((h) => ownLabel(h) === spec.label)
				: [...root.querySelectorAll("li")].find((l) => ownLabel(l).startsWith(spec.label));
			if (!owner) return { method: "reading-view indicator", found: false, collapsed: null };
			const indicator = owner.querySelector(":scope > .collapse-indicator, :scope > .heading-collapse-indicator");
			return { method: "reading-view indicator", found: true, collapsed: owner.classList.contains("is-collapsed") || !!(indicator && indicator.classList.contains("is-collapsed")) };
		}
		const lines = [...surfaceOf(view).querySelectorAll(".cm-line")].map((l) => l.textContent);
		const parentVisible = lines.some((l) => (isHeading ? l.replace(/^#+\s*/, "").trim() === spec.label : l.includes(spec.label)));
		const childVisible = lines.some((l) => l.includes(spec.childText));
		return { method: "live-preview editor lines", found: parentVisible, collapsed: parentVisible ? !childVisible : null };
	}

	/** Whether the embed's rendered text contains `text` (works while its items are folded, unlike
	 * reading toggle labels, but a folded section may not have rendered its children at all). */
	function embedHasText(path, key, text) {
		const view = viewFor(path);
		if (!view) throw new Error("host is not open");
		const root = surfaceOf(view);
		const embed = topEmbeds(root).find((e) => embedKeyOf(e, root) === key);
		if (!embed) throw new Error("no embed with key " + key);
		return embed.textContent.includes(text);
	}

	// ---- 51-embed lazy rendering ------------------------------------------------------------------
	function countEmbeds(path) {
		const view = viewFor(path);
		if (!view) return { error: "host is not open" };
		const embeds = topEmbeds(surfaceOf(view));
		return { inDom: embeds.length, rendered: embeds.filter(isRendered).length };
	}

	/** Opens `path` and counts how many top-level embeds exist in the DOM and have rendered at each
	 * of `atMs` (measured from the moment setViewState resolved), without waiting for quiet. */
	async function openAndSample(path, mode, atMs) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!file) throw new Error("no such file in the vault: " + path);
		closeLeavesFor(path);
		const leaf = newLeaf();
		await leaf.setViewState({
			type: "markdown",
			state: { file: path, mode: mode === "rv" ? "preview" : "source", source: false },
			active: true,
		});
		app.workspace.setActiveLeaf(leaf, { focus: true });
		const t0 = now();
		const samples = [];
		for (const at of atMs) {
			const wait = at - (now() - t0);
			if (wait > 0) await sleep(wait);
			samples.push({ atMs: at, actualMs: round(now() - t0), ...countEmbeds(path) });
		}
		return samples;
	}

	// ---- hover previews ---------------------------------------------------------------------------
	function hoverLinkRect(path) {
		const view = viewFor(path);
		const a = surfaceOf(view).querySelector("a.internal-link");
		if (!a) throw new Error("no internal link in " + path);
		const r = a.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	}

	function hoverPopovers() {
		return [...document.querySelectorAll(".hover-popover")].map((p) => {
			const embeds = [...p.querySelectorAll(".internal-embed")];
			const note = embeds.filter((e) => e.classList.contains("markdown-embed"));
			return {
				classes: [...p.classList],
				embeds: embeds.length,
				noteEmbeds: note.length,
				loadedNoteEmbeds: note.filter((e) => e.classList.contains("is-loaded")).length,
				insideWorkspaceMarkdownView: embeds.some((e) => containerRule(e) !== null),
				detections: embeds.map((e) => containerRule(e)),
			};
		});
	}

	function pluginInfo() {
		return {
			obsidianVersion: (navigator.userAgent.match(/obsidian\/([\d.]+)/i) || [])[1] || null,
			vaultName: app.vault.getName(),
			basePath: app.vault.adapter.basePath,
		};
	}

	/** Fallback for a host file system whose change watcher missed a new file: writes the same text
	 * through Obsidian's own adapter so the file gets indexed. Only used when the file is unknown. */
	async function ensureFile(path, text) {
		if (app.vault.getAbstractFileByPath(path)) return false;
		const folder = path.slice(0, path.lastIndexOf("/"));
		if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.adapter.mkdir(folder);
		await app.vault.adapter.write(path, text);
		return true;
	}

	function fileReady(path) {
		const f = app.vault.getAbstractFileByPath(path);
		return !!(f && app.metadataCache.getFileCache(f));
	}

	window.__pfsEmbedProbe = {
		version: 1,
		sleep,
		closeLeavesFor,
		closeProbeLeaves,
		snapshot,
		openHost,
		openPlain,
		startRecorder,
		recordHost,
		recorders,
		stopRecorder,
		waitQuiet,
		summarize,
		rectOf,
		armEvents,
		disarmEvents,
		readEvents,
		toggleState,
		syntheticClick,
		foldKeys,
		clearFoldKeys,
		sourceNoteState,
		embedHasText,
		countEmbeds,
		openAndSample,
		hoverLinkRect,
		hoverPopovers,
		pluginInfo,
		fileReady,
		ensureFile,
	};
	return "installed";
})();
