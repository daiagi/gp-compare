import { existsSync, readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it, vi } from "vitest";
import { extractRuns } from "./pdfText";
import { archiveUrls } from "./archive";
import { compareDocs, loadDoc, type Side } from "./compare";
import { type Change, chars, diffChars, findChanges, type TextRun } from "./words";

/** One page of runs; a run ends its line unless the next one starts with "+". */
const page = (...texts: string[]) =>
  texts.map((t, index): TextRun => ({ index, text: t.replace(/^\+/, ""), eol: !texts[index + 1]?.startsWith("+"), x0: 0, y0: 0.5, x1: 1, y1: 0.6 }));

/** The removed and added text of every edit, without spaces. */
function edits(left: TextRun[], right: TextRun[]) {
  const [a, b] = [chars([left]), chars([right])];
  const text = (cs: typeof a, from: number, to: number) => cs.slice(from, to).map((c) => c.ch).join("");
  return diffChars(a, b).map((e) => [text(a, e.a0, e.a1), text(b, e.b0, e.b1)]);
}

describe("diffChars", () => {
  it("marks a removed clause without its neighbours or the punctuation around it", () => {
    const left = page("sequences", "+ ", "+x", "+, fully defined in equation H.4. We may");
    const right = page("sequences", "+ ", "+x", "+.", "+ ", "+We may");
    expect(edits(left, right)).toEqual([["fullydefinedinequationH.4", ""]]);
    const [e] = diffChars(chars([left]), chars([right]));
    expect([chars([left])[e.a0].offset, chars([left])[e.a1].offset]).toEqual([2, 31]);
  });

  it("ignores reflow, hyphenation and spacing", () => {
    expect(edits(page("apply to sequences-of-tu-", "ples to yield"), page("apply to sequences-of-", "tuples to yield"))).toEqual([]);
    expect(edits(page("x", "+▸", "+y"), page("x", "+ ", "+▸", "+y"))).toEqual([]);
  });

  it("ignores punctuation that is the only difference", () => {
    expect(edits(page("one, two and three. Four"), page("one; two, and three: Four"))).toEqual([]);
  });

  it("puts added text on sentence boundaries when it could sit at several places", () => {
    const left = page("yield a tuple of se-", "quences.", "We denote");
    const right = page("yield a tuple of sequences.", "(3.12)", "+T", "+[]", "We write m empty sequences.", "We denote");
    expect(edits(left, right)).toEqual([["", "(3.12)T[]Wewritememptysequences."]]);
    expect(edits(page("(H.3)", "We define this.", "We may then"), page("(H.3)", "We may then"))).toEqual([["Wedefinethis.", ""]]);
  });

  it("marks only the glyphs that differ in math, and no renumbered equation tag", () => {
    const left = page("(H.5)", "+ ", "+C", "+N", "+∶", "+⎧");
    const right = page("(H.4)", "+ ", "+C", "+N", "+1", "+...", "+ ", "+∶", "+⎧");
    expect(edits(left, right)).toEqual([["", "1..."]]);
  });

  it("marks whole words in prose", () => {
    expect(edits(page("a set of secrets"), page("a sequence of secrets"))).toEqual([["set", "sequence"]]);
  });

  it("leaves the running header out, except on the first page", () => {
    const header = (date: string): TextRun => ({ index: 0, text: `DRAFT ${date}`, eol: true, x0: 0, y0: 0.06, x1: 1, y1: 0.07 });
    expect(chars([[header("May")], [header("May")]]).map((c) => c.page)).toEqual(Array(8).fill(1));
  });
});

// Acceptance checks on PR #590 of gavofyork/graypaper: the six changes and nothing else.
const DIST = new URL("../../workspace/dist", import.meta.url).pathname;
const SHAS = { left: "c8fd174b68fe089a1cb0270783edd74ff9ae1777", right: "432bc8ec9772587f54700c0c5fe252f337f30a5e" };
const built = Object.values(SHAS).every((sha) => existsSync(archiveUrls(DIST, sha).pdf));

describe.skipIf(!built)("findChanges on PR #590", async () => {
  if (!built) return;
  vi.stubGlobal("fetch", async (path: string) => {
    const body = existsSync(path) ? readFileSync(path, "utf8") : null;
    return { ok: body !== null, json: async () => JSON.parse(body ?? ""), text: async () => body ?? "" };
  });
  const load = async (sha: string) => {
    const urls = archiveUrls(DIST, sha);
    const pdf = await getDocument({ data: new Uint8Array(readFileSync(urls.pdf)), verbosity: 0 }).promise;
    const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => extractRuns(pdf, i + 1)));
    return { doc: await loadDoc(urls.synctex, urls.tex), pages };
  };
  const [left, right] = await Promise.all([load(SHAS.left), load(SHAS.right)]);
  const pages = { left: left.pages, right: right.pages };
  const changes = findChanges(compareDocs(left.doc, right.doc), pages);
  vi.unstubAllGlobals();

  /** The marked text of a change on one side, without spaces and hyphens, one string per edit. */
  const marked = (change: Change, side: Side) => {
    const byEdit = new Map<number, string>();
    for (const m of change.marks[side]) {
      const text = pages[side][m.page - 1][m.run].text.slice(m.start, m.end).replace(/[\s\-‐]/g, "");
      byEdit.set(m.edit, (byEdit.get(m.edit) ?? "") + text);
    }
    return [...byEdit.values()];
  };
  const TRANSPOSE = "T[[x0,0,x0,1,x0,2,...],[x1,0,x1,1,...],...]≡[[x0,0,x1,0,x2,0,...],[x0,1,x1,1,...],...]";
  const WE_WRITE = "WewriteTmforthesameoperatorwheretheresultisknowntohavemitems,whichalsodefinestheemptycase:Tm[]isasequenceofmemptysequences.";

  it("finds six changes, on pages 7 and 75", () => {
    expect(changes.map((c) => [c.left.page, c.right.page])).toEqual([[7, 7], [75, 75], [75, 75], [75, 75], [75, 75], [75, 75]]);
    const markedPages = changes.flatMap((c) => [...c.marks.left, ...c.marks.right].map((m) => m.page));
    expect([...new Set(markedPages)]).toEqual([7, 75]);
    const total = (side: Side) => changes.flatMap((c) => marked(c, side)).join("").length;
    expect([total("left"), total("right")]).toEqual([277, 291]);
  });

  it("1: the clause removed from 3.7.2, the equation and paragraph added", () => {
    expect(marked(changes[0], "left")).toEqual(["fullydefinedinequationH.4"]);
    expect(marked(changes[0], "right")).toEqual([`(3.12)${TRANSPOSE}${WE_WRITE}`]);
    expect(changes[0].marks.left.map((m) => m.run)).toEqual([760]);
    expect(changes[0].marks.right.every((m) => m.run >= 764 && m.run <= 865)).toBe(true);
  });

  it("2, 3, 6: only the new subscript of N", () => {
    for (const [i, runs] of [[1, [104, 105]], [2, [156, 157]], [5, [385, 386]]] as const) {
      expect(marked(changes[i], "left")).toEqual([]);
      expect(marked(changes[i], "right")).toEqual(["1..."]);
      expect(changes[i].marks.right.map((m) => m.run)).toEqual(runs);
    }
  });

  it("4: the transposition paragraph removed from H.1, and nothing of the paragraph after it", () => {
    expect(marked(changes[3], "left")).toEqual([`Wedefinethetranspositionoperatorhence:(H.4)${TRANSPOSE}${WE_WRITE}`]);
    expect(marked(changes[3], "right")).toEqual([]);
    expect(changes[3].marks.left.every((m) => m.run >= 257 && m.run <= 362)).toBe(true);
  });

  it("5: the subscript and the added sentence, as one change", () => {
    expect(marked(changes[4], "left")).toEqual([]);
    expect(marked(changes[4], "right")).toEqual(["1...", "NotethatTisthetranspositionoperator,asdefinedinequation3.12."]);
  });

  it("marks no renumbered equation tag and nothing whose source only changed", () => {
    const tags = (side: Side) =>
      changes.flatMap((c) => c.marks[side]).map((m) => pages[side][m.page - 1][m.run].text).filter((t) => /^\(\w+\.\d+\)$/.test(t));
    expect(tags("left")).toEqual(["(H.4)"]);
    expect(tags("right")).toEqual(["(3.12)"]);
    const paths = changes.flatMap((c) => c.source.map((s) => s.path));
    expect(new Set(paths)).toEqual(new Set(["text/notation.tex", "text/erasure_coding.tex"]));
  });
});
