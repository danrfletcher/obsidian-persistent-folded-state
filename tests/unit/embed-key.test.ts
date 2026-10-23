/**
 * src/embed-key.ts: embed parsing, the occurrence index, key shape, nested chain keys, and the
 * "no throw, no backtracking" edge cases (ticket warkworth-21 PR-3: G5, G7, G12, GP1, E1, E15).
 */
import { describe, expect, it } from "vitest";
import {
	buildChainKey,
	buildEmbedKey,
	encodeEmbedKey,
	findEmbedKey,
	findEmbeds,
	listEmbedKeys,
	parseEmbedLinktext,
	type LinkResolver,
} from "../../src/embed-key";
import { sliceEmbed } from "../../src/embed-slice";

const HOST = "Host.md";

/** target, subpath and occurrence of every embed found: the shape the tables below assert on. */
function summary(text: string, resolve?: LinkResolver): [string, string, number][] {
	return findEmbeds(HOST, text, resolve).map((e) => [e.target, e.subpath, e.occurrence]);
}

describe("findEmbeds: parse rule (G12, E1)", () => {
	const cases: { name: string; text: string; expected: [string, string, number][] }[] = [
		{ name: "wikilink, whole note", text: "![[A]]", expected: [["A", "", 0]] },
		{ name: "wikilink with a path", text: "![[folder/sub/A]]", expected: [["folder/sub/A", "", 0]] },
		{ name: "wikilink with .md", text: "![[A.md]]", expected: [["A", "", 0]] },
		{ name: "block", text: "![[A#^0169a6]]", expected: [["A", "^0169a6", 0]] },
		{ name: "heading", text: "![[A#Lesson 8]]", expected: [["A", "Lesson 8", 0]] },
		{ name: "nested heading", text: "![[A#Part#Lesson 8]]", expected: [["A", "Part#Lesson 8", 0]] },
		{ name: "alias", text: "![[A|the alias]]", expected: [["A", "", 0]] },
		{ name: "size", text: "![[A|300]]", expected: [["A", "", 0]] },
		{ name: "block with alias", text: "![[A#^x|alias]]", expected: [["A", "^x", 0]] },
		{ name: "escaped bar (inside a table)", text: "![[A\\|alias]]", expected: [["A", "", 0]] },
		{ name: "spaces around the link are trimmed", text: "![[ A # Head ]]", expected: [["A", "Head", 0]] },
		{ name: "same-note heading targets the host", text: "![[#Intro]]", expected: [["Host.md", "Intro", 0]] },
		{ name: "markdown link", text: "![](A.md)", expected: [["A", "", 0]] },
		{ name: "markdown link with alt text", text: "![alt text](A.md)", expected: [["A", "", 0]] },
		{ name: "markdown link, percent-encoded", text: "![](A%20B.md)", expected: [["A B", "", 0]] },
		{ name: "markdown link with block", text: "![](A.md#^x1)", expected: [["A", "^x1", 0]] },
		{ name: "markdown link with encoded heading", text: "![](A.md#Lesson%208)", expected: [["A", "Lesson 8", 0]] },
		{ name: "markdown link in angle brackets", text: "![](<A B.md>)", expected: [["A B", "", 0]] },
		{ name: "markdown link with a title", text: '![](A.md "a title")', expected: [["A", "", 0]] },
		{ name: "markdown link with parentheses in the path", text: "![](A%20(1).md)", expected: [["A (1)", "", 0]] },
		{ name: "markdown link with a bad percent escape stays as written", text: "![](100%.md)", expected: [["100%", "", 0]] },
		{ name: "markdown link to a web url is not a note", text: "![](https://example.com/a.md)", expected: [] },
		{ name: "markdown link to a non-md path is not a note", text: "![](A)", expected: [] },
		{ name: "plain wikilink (no bang) is not an embed", text: "[[A]]", expected: [] },
		{ name: "image wikilink", text: "![[photo.png]]", expected: [] },
		{ name: "image extension is case-insensitive", text: "![[photo.PNG]]", expected: [] },
		{ name: "image with size", text: "![[photo.jpg|200]]", expected: [] },
		{ name: "pdf", text: "![[paper.pdf#page=3]]", expected: [] },
		{ name: "audio", text: "![[clip.mp3]]", expected: [] },
		{ name: "video", text: "![[clip.mp4]]", expected: [] },
		{ name: "markdown image", text: "![](pic.png)", expected: [] },
		{ name: "a note whose name has a dot is still a note", text: "![[Meeting 1.5]]", expected: [["Meeting 1.5", "", 0]] },
		{
			name: "a non-note embed does not count toward any index",
			text: "![[A]]\n![[pic.png]]\n![[A]]",
			expected: [["A", "", 0], ["A", "", 1]],
		},
		{
			name: "embed inside a list, quote and sentence",
			text: "- ![[A]]\n> ![[B]]\ntext ![[C]] more",
			expected: [["A", "", 0], ["B", "", 0], ["C", "", 0]],
		},
		{
			name: "document order across both syntaxes",
			text: "![[B]] ![](A.md) ![[C#^z]]",
			expected: [["B", "", 0], ["A", "", 0], ["C", "^z", 0]],
		},
	];

	it.each(cases)("$name", ({ text, expected }) => {
		expect(summary(text)).toEqual(expected);
	});

	it("keeps unicode, emoji and CJK titles and subpaths unchanged", () => {
		expect(summary("![[日本語のノート#見出し 🚀]]\n![[Café ☕/Ünï#^ñ1]]")).toEqual([
			["日本語のノート", "見出し 🚀", 0],
			["Café ☕/Ünï", "^ñ1", 0],
		]);
	});
});

describe("findEmbeds: text that is not an embed", () => {
	const A = "![[A]]";
	const cases: { name: string; text: string; expected: number }[] = [
		{ name: "fenced code (backticks)", text: `\`\`\`\n${A}\n\`\`\`\n${A}`, expected: 1 },
		{ name: "fenced code (tildes) with info string", text: `~~~md\n${A}\n~~~\n${A}`, expected: 1 },
		{ name: "a longer fence is not closed by a shorter one", text: `\`\`\`\`\n\`\`\`\n${A}\n\`\`\`\`\n${A}`, expected: 1 },
		{ name: "an unclosed fence runs to the end", text: `${A}\n\`\`\`\n${A}\n${A}`, expected: 1 },
		{ name: "indented fence in a list", text: `- item\n  \`\`\`\n  ${A}\n  \`\`\`\n- ${A}`, expected: 1 },
		{ name: "fenced code inside a callout", text: `> \`\`\`\n> ${A}\n> \`\`\`\n${A}`, expected: 1 },
		{ name: "fenced code inside a callout, no space after >", text: `>\`\`\`\n>${A}\n>\`\`\`\n${A}`, expected: 1 },
		{ name: "tilde fence in a callout with an info string", text: `> [!note] T\n> ~~~md\n> ${A}\n> ~~~\n> ${A}`, expected: 1 },
		{ name: "fence in a nested blockquote", text: `> > \`\`\`\n> > ${A}\n> > \`\`\`\n${A}`, expected: 1 },
		{ name: "an embed in a callout outside any fence counts", text: `> [!note]\n> ${A}\n${A}`, expected: 2 },
		{ name: "a callout fence that is never closed ends with the callout", text: `> \`\`\`\n> ${A}\n\n${A}`, expected: 1 },
		{ name: "a fence line in a callout does not open a fence for the lines after the callout", text: `> \`\`\`\n> x\n> \`\`\`\n${A}\n${A}`, expected: 2 },
		{ name: "a quoted fence line does not close a top-level fence", text: `\`\`\`\n> \`\`\`\n${A}\n\`\`\`\n${A}`, expected: 1 },
		{ name: "a backslash-escaped ! (a link after a literal !, PR-3 R3)", text: `\\${A}\n${A}`, expected: 1 },
		{ name: "an escaped ! in the middle of a line", text: `see \\${A} and ${A}`, expected: 1 },
		{ name: "an escaped backslash does not escape the !", text: `\\\\${A}\n${A}`, expected: 2 },
		{ name: "inline code", text: `\`${A}\` and ${A}`, expected: 1 },
		{ name: "double-backtick inline code holding a backtick", text: `\`\` ${A} \` \`\` ${A}`, expected: 1 },
		{ name: "an unmatched backtick is plain text", text: `\` ${A}`, expected: 1 },
		{ name: "three backticks on one line are inline code, not a fence", text: `\`\`\`${A}\`\`\`\n${A}`, expected: 1 },
		{ name: "%%comment%% on one line", text: `%%${A}%% ${A}`, expected: 1 },
		{ name: "%%comment%% over several lines", text: `%%\n${A}\n%%\n${A}`, expected: 1 },
		{ name: "html comment", text: `<!-- ${A} -->${A}`, expected: 1 },
		{ name: "html comment over several lines", text: `<!--\n${A}\n-->\n${A}`, expected: 1 },
		{ name: "frontmatter", text: `---\nlink: "${A}"\n---\n${A}`, expected: 1 },
		{ name: "frontmatter closed by ...", text: `---\nlink: "${A}"\n...\n${A}`, expected: 1 },
		{ name: "an unclosed --- is not frontmatter", text: `---\n${A}\n${A}`, expected: 2 },
		{ name: "--- that is not the first line is not frontmatter", text: `${A}\n---\n${A}\n---`, expected: 2 },
	];

	it.each(cases)("$name", ({ text, expected }) => {
		expect(findEmbeds(HOST, text)).toHaveLength(expected);
	});

	it("counts only embeds outside code and comments toward the index", () => {
		const text = "![[A]]\n```\n![[A]]\n```\n`![[A]]`\n%%![[A]]%%\n<!-- ![[A]] -->\n![[A]]";
		expect(summary(text)).toEqual([["A", "", 0], ["A", "", 1]]);
	});
});

describe("same-note and case variants count as identical embeds (PR-3 R6)", () => {
	it("![[#H]] and ![[Host#H]] in Host.md are the same note: one target, occurrences 0 and 1", () => {
		const host = HOST.replace(/\.md$/, "");
		expect(summary(`![[#H]] ![[${host}#H]]`)).toEqual([
			[HOST, "H", 0],
			[HOST, "H", 1],
		]);
	});

	it("a link to the host with its extension counts the same", () => {
		expect(summary(`![[#H]] ![[${HOST}#H]]`).map((r) => r[2])).toEqual([0, 1]);
	});

	it("A#Intro and A#intro count together, each keeping the subpath as written", () => {
		expect(summary("![[A#Intro]] ![[A#intro]] ![[A#Intro]]")).toEqual([
			["A", "Intro", 0],
			["A", "intro", 1],
			["A", "Intro", 2],
		]);
	});

	it("block ids stay case-sensitive", () => {
		expect(summary("![[A#^Ab]] ![[A#^ab]]").map((r) => r[2])).toEqual([0, 0]);
	});

	it("findEmbedKey finds the second of two case variants", () => {
		const text = "![[A#Intro]] ![[A#intro]]";
		expect(findEmbedKey(HOST, text, "A#intro", 1)).toEqual({ host: HOST, target: "A", subpath: "intro", occurrence: 1 });
		expect(findEmbedKey(HOST, text, "A#INTRO", 0)).toEqual({ host: HOST, target: "A", subpath: "Intro", occurrence: 0 });
	});
});

describe("occurrence index (G5, G7, E1, E15)", () => {
	const fold = (text: string) => summary(text);

	it("G7: two identical embeds differ only in the occurrence index (0, 1)", () => {
		const [first, second] = listEmbedKeys(HOST, "![[A#^x]]\ntext\n![[A#^x]]");
		expect(first).toEqual({ host: HOST, target: "A", subpath: "^x", occurrence: 0 });
		expect(second).toEqual({ host: HOST, target: "A", subpath: "^x", occurrence: 1 });
	});

	it("E1: alias and size are ignored when deciding that embeds are identical", () => {
		expect(fold("![[A#^x|alias]] ![[A#^x|300]] ![[A#^x]]")).toEqual([
			["A", "^x", 0],
			["A", "^x", 1],
			["A", "^x", 2],
		]);
	});

	it("embeds with a different subpath or target are not identical", () => {
		expect(fold("![[A]] ![[A#^x]] ![[A#H]] ![[B]] ![[A]]")).toEqual([
			["A", "", 0],
			["A", "^x", 0],
			["A", "H", 0],
			["B", "", 0],
			["A", "", 1],
		]);
	});

	it("both syntaxes count together: ![[A]] and ![](A.md) are identical", () => {
		expect(fold("![[A]] ![](A.md) ![[A.md]]")).toEqual([["A", "", 0], ["A", "", 1], ["A", "", 2]]);
	});

	describe("G5 / E15: what moves an index and what never does", () => {
		const base = "![[A]]\nline\n![[A]]\nline\n![[A]]";
		const cases: { name: string; text: string; occurrences: number[] }[] = [
			{ name: "baseline", text: base, occurrences: [0, 1, 2] },
			{ name: "G5: lines inserted around the embeds", text: `intro\n\n${base}\n\noutro\nmore`, occurrences: [0, 1, 2] },
			{ name: "G5: text inserted on the same line", text: base.replace("![[A]]", "before ![[A]] after"), occurrences: [0, 1, 2] },
			{ name: "E15: identical embed inserted before shifts later ones", text: `![[A]]\n${base}`, occurrences: [0, 1, 2, 3] },
			{ name: "E15: identical embed inserted between", text: base.replace("line\n![[A]]\nline", "line\n![[A]]\n![[A]]\nline"), occurrences: [0, 1, 2, 3] },
			{ name: "E15: identical embed inserted after adds one at the end", text: `${base}\n![[A]]`, occurrences: [0, 1, 2, 3] },
			{ name: "E15: identical embed deleted before shifts them back", text: "line\n![[A]]\nline\n![[A]]", occurrences: [0, 1] },
			{ name: "a different embed inserted before never shifts", text: `![[B]]\n![[A#^x]]\n${base}`, occurrences: [0, 1, 2] },
			{ name: "a different embed inserted between never shifts", text: base.replace("line\n![[A]]\nline", "line\n![[B]]\n![[A]]\nline"), occurrences: [0, 1, 2] },
		];

		it.each(cases)("$name", ({ text, occurrences }) => {
			const forA = findEmbeds(HOST, text)
				.filter((e) => e.target === "A" && e.subpath === "")
				.map((e) => e.occurrence);
			expect(forA).toEqual(occurrences);
		});

		it("keys carry no line number, offset or host text hash: only host, target, subpath, occurrence", () => {
			for (const key of listEmbedKeys(HOST, `intro\n${base}`)) {
				expect(Object.keys(key).sort()).toEqual(["host", "occurrence", "subpath", "target"]);
			}
		});

		it("the same embed has the same key wherever it sits in the host", () => {
			const before = findEmbedKey(HOST, "![[A#^x]]", "A#^x");
			const after = findEmbedKey(HOST, "lots\nof\nlines\n\n\nabove\n\n  text ![[A#^x]] trailing", "A#^x");
			expect(after).toEqual(before);
		});
	});

	it("the index depends only on the text: the same text gives the same result, whatever else ran", () => {
		const text = "![[A]] ![[B]] ![[A]]";
		const first = findEmbeds(HOST, text);
		findEmbeds(HOST, "![[A]] ![[A]] ![[A]] ![[A]]");
		listEmbedKeys("Other.md", "![[Z]]");
		expect(findEmbeds(HOST, text)).toEqual(first);
	});
});

describe("link resolution is injected (E1)", () => {
	const CCF = "Competitive Coding Fundamentals";
	const resolveCcf: LinkResolver = (linktext) =>
		linktext === CCF || linktext === `${CCF}/${CCF}` ? `${CCF}/${CCF}.md` : null;

	it("two link texts that resolve to one path are identical for the index", () => {
		const text = `![[${CCF}]]\n![[${CCF}/${CCF}]]`;
		expect(summary(text, resolveCcf)).toEqual([
			[`${CCF}/${CCF}.md`, "", 0],
			[`${CCF}/${CCF}.md`, "", 1],
		]);
	});

	it("without a resolver the same two link texts are different embeds", () => {
		const text = `![[${CCF}]]\n![[${CCF}/${CCF}]]`;
		expect(summary(text)).toEqual([[CCF, "", 0], [`${CCF}/${CCF}`, "", 0]]);
	});

	it("the resolver receives the link text without subpath or alias", () => {
		const seen: string[] = [];
		summary("![[A B#^x|alias]] ![](C%20D.md#H)", (t) => (seen.push(t), null));
		expect(seen).toEqual(["A B", "C D.md"]);
	});

	it("an unresolved link falls back to its raw text and still pairs by order", () => {
		expect(summary("![[Ghost#^x]] ![[Ghost#^x]]", () => null)).toEqual([
			["Ghost", "^x", 0],
			["Ghost", "^x", 1],
		]);
	});

	it("a resolver that throws or returns a non-string is treated as unresolved", () => {
		const throwing: LinkResolver = () => {
			throw new Error("boom");
		};
		const wrong = (() => 42) as unknown as LinkResolver;
		expect(summary("![[A]]", throwing)).toEqual([["A", "", 0]]);
		expect(summary("![[A]]", wrong)).toEqual([["A", "", 0]]);
	});

	it("a resolved path that is not a note is not an embed", () => {
		expect(summary("![[Diagram]]", () => "assets/Diagram.png")).toEqual([]);
	});

	it("findEmbedKey resolves its own link text the same way", () => {
		const text = `![[${CCF}]]\n![[${CCF}/${CCF}#^a]]\n![[${CCF}/${CCF}#^a]]`;
		expect(findEmbedKey(HOST, text, `${CCF}#^a`, 1, resolveCcf)).toEqual({
			host: HOST,
			target: `${CCF}/${CCF}.md`,
			subpath: "^a",
			occurrence: 1,
		});
	});
});

describe("key shape and collisions", () => {
	it("buildEmbedKey returns structured fields", () => {
		expect(buildEmbedKey("H.md", { target: "T", subpath: "^a", occurrence: 3 })).toEqual({
			host: "H.md",
			target: "T",
			subpath: "^a",
			occurrence: 3,
		});
	});

	const awkward = ["#", "|", ">", "^", "/", ",", '"', "\\", " ", "]", "[", "%"];
	it.each(awkward)("a %j in a path cannot make two different keys equal", (ch) => {
		const keys = [
			buildEmbedKey(`a${ch}b`, { target: "c", subpath: "", occurrence: 0 }),
			buildEmbedKey("a", { target: `${ch}b`, subpath: "c", occurrence: 0 }),
			buildEmbedKey("a", { target: "b", subpath: `${ch}c`, occurrence: 0 }),
			buildEmbedKey("a", { target: `b${ch}c`, subpath: "", occurrence: 0 }),
			buildEmbedKey("a", { target: "b", subpath: `c${ch}`, occurrence: 0 }),
		];
		const encoded = keys.map(encodeEmbedKey);
		expect(new Set(encoded).size).toBe(keys.length);
	});

	it("fields that would join to the same string stay different keys", () => {
		const one = buildEmbedKey("a/b", { target: "c", subpath: "d", occurrence: 0 });
		const two = buildEmbedKey("a", { target: "b/c", subpath: "d", occurrence: 0 });
		const three = buildEmbedKey("a", { target: "b", subpath: "c#d", occurrence: 0 });
		const four = buildEmbedKey("a", { target: "b#c", subpath: "d", occurrence: 0 });
		expect(new Set([one, two, three, four].map(encodeEmbedKey)).size).toBe(4);
	});

	it("encodeEmbedKey round-trips through JSON to the same fields", () => {
		const key = buildEmbedKey('we"ird,#|>^/', { target: "t,#|", subpath: '^"x', occurrence: 2 });
		expect(JSON.parse(encodeEmbedKey(key))).toEqual([key.host, key.target, key.subpath, key.occurrence]);
	});

	it("paths with those characters come through the scan unchanged", () => {
		expect(summary("![[a,b/c>d^e#h|i]]")).toEqual([["a,b/c>d^e", "h", 0]]);
	});
});

describe("nested embeds are keyed by the chain (G12)", () => {
	const outer = { target: "Outer", subpath: "^o", occurrence: 0 };
	const inner = { target: "Inner", subpath: "", occurrence: 0 };

	it("builds host > outer > inner as ordered links", () => {
		expect(buildChainKey(HOST, [outer, inner])).toEqual({ host: HOST, chain: [outer, inner] });
	});

	it("the same inner embed reached by different chains has different keys", () => {
		const viaOuter = encodeEmbedKey(buildChainKey(HOST, [outer, inner]));
		const viaOther = encodeEmbedKey(buildChainKey(HOST, [{ ...outer, target: "Other" }, inner]));
		const viaOtherHost = encodeEmbedKey(buildChainKey("Other.md", [outer, inner]));
		const viaOuterTwo = encodeEmbedKey(buildChainKey(HOST, [{ ...outer, occurrence: 1 }, inner]));
		const direct = encodeEmbedKey(buildEmbedKey(HOST, inner));
		const keys = [viaOuter, viaOther, viaOtherHost, viaOuterTwo, direct];
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("chain order matters", () => {
		expect(encodeEmbedKey(buildChainKey(HOST, [outer, inner]))).not.toBe(encodeEmbedKey(buildChainKey(HOST, [inner, outer])));
	});

	it("the inner occurrence is counted in the outer embed's slice text", () => {
		const outerTarget = "intro\n- block with ![[Inner]] and ![[Inner]] ^o1\n- other ![[Inner]]\n";
		const slice = sliceEmbed(outerTarget, "^o1");
		expect(slice).not.toBeNull();
		const links = findEmbeds("Outer", slice?.text ?? "");
		expect(links.map((l) => l.occurrence)).toEqual([0, 1]);
		const keys = links.map((l) => buildChainKey(HOST, [outer, l]));
		expect(keys[0].chain[1].occurrence).toBe(0);
		expect(keys[1].chain[1].occurrence).toBe(1);
	});

	it("does not alias its input", () => {
		const chain = [outer, inner];
		const key = buildChainKey(HOST, chain);
		key.chain[0].occurrence = 9;
		expect(outer.occurrence).toBe(0);
	});
});

describe("findEmbedKey and parseEmbedLinktext", () => {
	it("parses Obsidian's embed link text", () => {
		expect(parseEmbedLinktext("A#^x")).toEqual({ target: "A", subpath: "^x" });
		expect(parseEmbedLinktext("A#H1#H2")).toEqual({ target: "A", subpath: "H1#H2" });
		expect(parseEmbedLinktext("A|alias")).toEqual({ target: "A", subpath: "" });
		expect(parseEmbedLinktext("")).toBeNull();
		expect(parseEmbedLinktext(undefined as unknown as string)).toBeNull();
	});

	it("returns null when the host has fewer than occurrence+1 such embeds", () => {
		expect(findEmbedKey(HOST, "![[A]]", "A", 1)).toBeNull();
		expect(findEmbedKey(HOST, "![[A]]", "B", 0)).toBeNull();
		expect(findEmbedKey(HOST, "", "A", 0)).toBeNull();
	});

	it("picks the n-th identical embed in document order", () => {
		const text = "![[A#^x|one]]\n![[A#^y]]\n![[A#^x|two]]";
		expect(findEmbedKey(HOST, text, "A#^x", 1)).toEqual({ host: HOST, target: "A", subpath: "^x", occurrence: 1 });
	});
});

describe("GP1: the Rocketship shape", () => {
	const TARGET = "Competitive Coding Fundamentals";
	const targetText = [
		"# Competitive Coding Fundamentals",
		"",
		"- Lesson 7: Recursion",
		"  - [x] Watch [[Recursion video|the video]] (12:30)",
		"- Lesson 8: Collections and frequency counting ^0169a6",
		"  - [x] Watch [[Collections video|video]] (14:02)",
		"  - [x] Read [the notes](https://example.com/notes) 00:45:10",
		"  - [x] Do the [[Frequency exercises#Set A|exercises]] — done 2026-09-30 09:15",
		"  - [ ] Review the sub-tasks",
		"- Lesson 9: Sorting",
		"  - [ ] Merge sort",
	].join("\n");

	const embeds: string[] = [];
	for (let i = 1; i <= 50; i++) {
		embeds.push(i === 8 ? `- [ ] Lesson 8 ![[${TARGET}#^0169a6]]` : `- [ ] Lesson ${i} ![[Lesson ${i} Note#^b${i}]]`);
	}
	embeds.splice(20, 0, "![[hero.png]]", "![](diagram.svg)", "![[intro.mp3]]");
	embeds.push("![[Appendix]]");
	const host = ["---", "tags: [course]", "link: ![[Not An Embed]]", "---", "# Salesforce Tech Test Rocketship Course", "", ...embeds, ""].join("\n");

	it("finds 51 note embeds and ignores the image, svg and audio", () => {
		expect(findEmbeds("Rocketship.md", host)).toHaveLength(51);
	});

	it("returns the key of the Lesson 8 embed and a slice holding Lesson 8 and its sub-tasks", () => {
		const key = findEmbedKey("Rocketship.md", host, `${TARGET}#^0169a6`);
		expect(key).toEqual({ host: "Rocketship.md", target: TARGET, subpath: "^0169a6", occurrence: 0 });
		const slice = sliceEmbed(targetText, key?.subpath ?? "");
		const lines = (slice?.text ?? "").split("\n");
		expect(lines[0]).toBe("- Lesson 8: Collections and frequency counting ^0169a6");
		expect(lines).toHaveLength(5);
		expect(lines[4]).toBe("  - [ ] Review the sub-tasks");
		expect(slice?.text).not.toContain("Lesson 9");
	});
});

describe("edge cases: no throw, no backtracking", () => {
	const malformed = ["", "![[", "![[]]", "![[A#]]", "![](", "![]()", "![[A", "![[A]", "![", "!", "![[[A]]]", "![[A\n]]", "![[A]]]", "![[|alias]]", "![[#]]", "![](<", "![](<A.md"];

	it.each(malformed)("%j does not throw", (text) => {
		expect(() => findEmbeds(HOST, text)).not.toThrow();
		expect(() => listEmbedKeys(HOST, text)).not.toThrow();
		expect(() => findEmbedKey(HOST, text, "A")).not.toThrow();
	});

	it("![[A#]] is the whole note A; the others yield no embed", () => {
		expect(summary("![[A#]]")).toEqual([["A", "", 0]]);
		for (const text of ["![[", "![[]]", "![](", "![[#]]", "![[|alias]]", "![[A", "![]()"]) {
			expect(summary(text)).toEqual([]);
		}
	});

	it("an embed is found after a malformed one", () => {
		expect(summary("![[ ![[A]]")).toEqual([["A", "", 0]]);
		expect(summary("![](broken ![[A]]")).toEqual([["A", "", 0]]);
	});

	it("an empty host and a host with no embeds give an empty list", () => {
		expect(findEmbeds(HOST, "")).toEqual([]);
		expect(findEmbeds(HOST, "just text\n[[link]] and `code`")).toEqual([]);
		expect(findEmbeds(HOST, undefined as unknown as string)).toEqual([]);
	});

	const hostile: [string, string][] = [
		["unterminated ![[", "![[".repeat(34_000)],
		["unterminated ![[ with text", "![[a".repeat(25_000)],
		["unterminated ![](", "![](".repeat(25_000)],
		["a long unterminated wikilink", `![[${"a".repeat(100_000)}`],
		["a long unterminated markdown link", `![](${"a".repeat(100_000)}`],
		["unterminated backticks", "`".repeat(50_000)],
		["growing backtick runs", Array.from({ length: 400 }, (_, i) => "`".repeat(i + 1)).join(" ")],
		["unterminated comments", "%%![[A]]".repeat(10_000)],
		["unterminated html comments", "<!--![[A]]".repeat(10_000)],
		["many fences", "```\n".repeat(30_000)],
		["many short lines", "![[A]]\n".repeat(30_000)],
	];

	it.each(hostile)("%s finishes in under one second", (_name, text) => {
		const start = performance.now();
		expect(() => findEmbeds(HOST, text)).not.toThrow();
		expect(performance.now() - start).toBeLessThan(1000);
	});

	it("a 100,000-character line of unterminated ![[ gives an empty result", () => {
		expect(findEmbeds(HOST, "![[".repeat(33_334))).toEqual([]);
	});

	it("many embeds on one line are all found", () => {
		const found = findEmbeds(HOST, "![[A]]".repeat(20_000));
		expect(found).toHaveLength(20_000);
		expect(found[19_999].occurrence).toBe(19_999);
	});
});

describe("line endings", () => {
	const lf = "intro\n![[A#^x]]\n```\n![[A#^x]]\n```\n![](A.md)\n";
	const variants: [string, string][] = [
		["CRLF", lf.replace(/\n/g, "\r\n")],
		["bare CR", lf.replace(/\n/g, "\r")],
		["no trailing newline", lf.slice(0, -1)],
		["extra trailing newlines", `${lf}\n\n`],
	];

	it.each(variants)("%s gives the same keys as LF", (_name, text) => {
		expect(listEmbedKeys(HOST, text)).toEqual(listEmbedKeys(HOST, lf));
		expect(listEmbedKeys(HOST, lf)).toHaveLength(2);
	});

	it("frontmatter and a fence are recognised with CRLF", () => {
		const text = "---\r\nk: ![[A]]\r\n---\r\n```\r\n![[A]]\r\n```\r\n![[B]]\r\n";
		expect(summary(text)).toEqual([["B", "", 0]]);
	});
});

describe("determinism: same input, same output, input untouched", () => {
	const text = "---\nk: v\n---\n![[A#^x|a]] ![](B%20C.md) ```\n![[A]]\n```\n![[A#^x]]";
	const resolve: LinkResolver = (t) => (t === "A" ? "A.md" : null);

	it("each exported function returns deeply equal output on a second call", () => {
		expect(findEmbeds(HOST, text, resolve)).toEqual(findEmbeds(HOST, text, resolve));
		expect(listEmbedKeys(HOST, text, resolve)).toEqual(listEmbedKeys(HOST, text, resolve));
		expect(findEmbedKey(HOST, text, "A#^x", 1, resolve)).toEqual(findEmbedKey(HOST, text, "A#^x", 1, resolve));
		expect(parseEmbedLinktext("A#^x")).toEqual(parseEmbedLinktext("A#^x"));
		const link = { target: "T", subpath: "", occurrence: 0 };
		expect(buildEmbedKey(HOST, link)).toEqual(buildEmbedKey(HOST, link));
		expect(buildChainKey(HOST, [link])).toEqual(buildChainKey(HOST, [link]));
		expect(encodeEmbedKey(buildEmbedKey(HOST, link))).toBe(encodeEmbedKey(buildEmbedKey(HOST, link)));
	});

	it("works on deep-frozen input and does not mutate it", () => {
		const link = Object.freeze({ target: "T", subpath: "^a", occurrence: 1 });
		const chain = Object.freeze([link, link]);
		const before = JSON.stringify([link, chain]);
		expect(() => buildChainKey(HOST, chain)).not.toThrow();
		expect(() => buildEmbedKey(HOST, link)).not.toThrow();
		expect(() => encodeEmbedKey(buildChainKey(HOST, chain))).not.toThrow();
		expect(JSON.stringify([link, chain])).toBe(before);
	});
});
