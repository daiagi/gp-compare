/**
 * What changed on the page. The rendered text of the two documents is diffed as a whole, word by
 * word and then character by character, so only what differs is marked. Whitespace, line breaks
 * and hyphens are not compared, so reflowed text is not a change. A difference counts only where
 * the TeX source changed too: everything else is a side effect (renumbering, a footnote landing
 * on another page).
 */
import type { Comparison, Doc, Position, Side } from "./compare";
import { blockRect, contains } from "./geometry";
import { diffAnchored, type IHunk } from "./lineDiff";

/** A text run on a page, as the PDF's text content lists it (empty runs excluded). */
export interface TextRun {
  /** Position among the page's non-empty runs; matches the order of the text layer's spans. */
  index: number;
  text: string;
  /** The run ends a line. */
  eol: boolean;
  /** Rough box, in fractions of the page. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Characters [start, end) of run `run` on page `page`, in UTF-16 code units as DOM ranges count. */
export interface Mark {
  page: number;
  run: number;
  start: number;
  end: number;
  /** Marks of one edit are drawn as one shape per line. */
  edit: number;
  /** Left edge of the column the run is in, for the change bar. */
  margin: number;
}

/** One stop of the navigation: the edits in one source paragraph. */
export interface Change {
  marks: Record<Side, Mark[]>;
  /** Where to scroll each side to. */
  left: Position;
  right: Position;
  /** The TeX hunks behind it. */
  source: { path: string; hunk: IHunk }[];
}

interface Char {
  ch: string;
  page: number;
  run: TextRun;
  offset: number;
  /** Starts a word, a line. */
  word: boolean;
  line: boolean;
  /** Part of an equation number. */
  tag: boolean;
}

/** Characters [a0, a1) of the left text were replaced by [b0, b1) of the right text. */
interface Edit {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

// TeX adds hyphens at line breaks and drops them when text reflows, so none are compared.
const HYPHENS = /[-‐­]/;
const EQUATION_TAG = /^\((?:[A-Z]|\d+)\.\d+\)$/;
/** Runs ending above this share of the page height are the running header (title, build date, page number). */
const HEADER_BOTTOM = 0.076;
const SENTENCE_END = /[.:;]/;
const PUNCTUATION = /[.,;:]/;
const LETTER = /[A-Za-z]/;
/** Character edits separated by fewer equal characters than this are one edit. */
const MIN_EQUAL = 4;

/** The compared characters of a document, in reading order. */
export function chars(pages: TextRun[][]): Char[] {
  const out: Char[] = [];
  pages.forEach((runs, i) => {
    let word = true;
    let line = true;
    for (const run of runs) {
      if (i > 0 && run.y1 < HEADER_BOTTOM) continue;
      const tag = EQUATION_TAG.test(run.text.trim());
      word ||= tag;
      let offset = 0;
      for (const ch of run.text) {
        const at = offset;
        offset += ch.length;
        if (/\s/.test(ch)) word = true;
        else if (!HYPHENS.test(ch)) {
          out.push({ ch, page: i + 1, run, offset: at, word, line, tag });
          word = line = false;
        }
      }
      word ||= tag;
      if (run.eol) {
        line = true;
        // A hyphen at a line end joins the two halves of a word.
        word ||= !/[-‐]$/.test(run.text.trimEnd());
      }
    }
  });
  return out;
}

/** The edits that turn the left text into the right text, each as small as it can be. */
export function diffChars(a: Char[], b: Char[]): Edit[] {
  const words = (cs: Char[]) => {
    const starts = cs.flatMap((c, i) => (c.word || i === 0 ? [i] : []));
    return { starts: [...starts, cs.length], texts: starts.map((s, k) => text(cs, s, starts[k + 1] ?? cs.length)) };
  };
  const wa = words(a);
  const wb = words(b);
  const edits: Edit[] = [];
  for (const h of diffAnchored(wa.texts, wb.texts)) {
    let [a0, a1, b0, b1] = [wa.starts[h.leftStart - 1], wa.starts[h.leftEnd - 1], wb.starts[h.rightStart - 1], wb.starts[h.rightEnd - 1]];
    while (a0 < a1 && b0 < b1 && a[a0].ch === b[b0].ch) {
      a0++;
      b0++;
    }
    while (a1 > a0 && b1 > b0 && a[a1 - 1].ch === b[b1 - 1].ch) {
      a1--;
      b1--;
    }
    if (a0 === a1 && b0 === b1) continue; // The words differed in spacing only.
    const inner: Edit[] = [];
    if (a0 < a1 && b0 < b1) {
      const letters = diffAnchored(a.slice(a0, a1).map((c) => c.ch), b.slice(b0, b1).map((c) => c.ch));
      for (const l of letters) {
        const e = { a0: a0 + l.leftStart - 1, a1: a0 + l.leftEnd - 1, b0: b0 + l.rightStart - 1, b1: b0 + l.rightEnd - 1 };
        const last = inner[inner.length - 1];
        // Letters matching by chance inside a rewrite would split it; whole words and equation numbers do not match by chance.
        const chance = last && e.a0 - last.a1 < MIN_EQUAL && !a[last.a0]?.tag && !(a[last.a1]?.word && a[e.a0]?.word !== false);
        if (chance) Object.assign(last, { a1: e.a1, b1: e.b1 });
        else inner.push(e);
      }
    }
    const equal = a1 - a0 - inner.reduce((n, e) => n + e.a1 - e.a0, 0);
    if (inner.length > 1 && equal * 2 >= Math.min(a1 - a0, b1 - b0)) edits.push(...inner);
    else edits.push({ a0, a1, b0, b1 });
  }

  edits.forEach((e, i) => {
    const lo = edits[i - 1] ?? { a1: 0, b1: 0 };
    const hi = edits[i + 1] ?? { a0: a.length, b0: b.length };
    // An edit never splits a prose word: "set" -> "sequence", not "t" -> "quence".
    while (e.a0 > lo.a1 && e.b0 > lo.b1 && (splitsWord(a, e.a0) || splitsWord(b, e.b0))) shift(e, -1, 0);
    while (e.a1 < hi.a0 && e.b1 < hi.b0 && (splitsWord(a, e.a1) || splitsWord(b, e.b1))) shift(e, 0, 1);
    // Text added or removed next to equal text can sit at several places: take the one on sentence or line boundaries.
    if (e.a0 === e.a1) shift(e, ...twice(slide(b, e.b0, e.b1, lo.b1, hi.b0)));
    else if (e.b0 === e.b1) shift(e, ...twice(slide(a, e.a0, e.a1, lo.a1, hi.a0)));
    // Punctuation before a space belongs to the word before it; alone it is not a change.
    while (e.a0 < e.a1 && closesWord(a, e.a0)) e.a0++;
    while (e.b0 < e.b1 && closesWord(b, e.b0)) e.b0++;
  });
  return edits.filter((e) => {
    if (e.a0 === e.a1 && e.b0 === e.b1) return false;
    // An equation number replaced by another one is renumbering.
    const renumbered = e.a0 < e.a1 && e.b0 < e.b1 && a.slice(e.a0, e.a1).every((c) => c.tag) && b.slice(e.b0, e.b1).every((c) => c.tag);
    return !renumbered;
  });
}

const twice = (k: number): [number, number] => [k, k];

function shift(e: Edit, start: number, end: number) {
  e.a0 += start;
  e.b0 += start;
  e.a1 += end;
  e.b1 += end;
}

function splitsWord(cs: Char[], i: number) {
  return i > 0 && i < cs.length && !cs[i].word && cs[i].run === cs[i - 1].run && LETTER.test(cs[i].ch) && LETTER.test(cs[i - 1].ch);
}

function closesWord(cs: Char[], i: number) {
  return PUNCTUATION.test(cs[i].ch) && (i + 1 === cs.length || cs[i + 1].word);
}

/** How far to move [start, end) over equal characters, within [lo, hi], to the best boundaries. */
function slide(cs: Char[], start: number, end: number, lo: number, hi: number) {
  const boundary = (i: number) => {
    if (i === 0 || i === cs.length || cs[i].line || cs[i].tag !== cs[i - 1].tag) return 2;
    return cs[i].word ? (SENTENCE_END.test(cs[i - 1].ch) ? 2 : 1) : 0;
  };
  let best = 0;
  let bestScore = boundary(start) + boundary(end);
  const consider = (k: number) => {
    const score = boundary(start + k) + boundary(end + k);
    if (score > bestScore) [best, bestScore] = [k, score];
  };
  for (let k = 1; start - k >= lo && cs[start - k].ch === cs[end - k].ch; k++) consider(-k);
  for (let k = 1; end + k <= hi && cs[start + k - 1].ch === cs[end + k - 1].ch; k++) consider(k);
  return best;
}

function text(cs: Char[], from: number, to: number) {
  let out = "";
  for (let i = from; i < to; i++) out += cs[i].ch;
  return out;
}

/** The changes between two documents, given the text runs of all their pages, in reading order. */
export function findChanges(comparison: Comparison, pages: Record<Side, TextRun[][]>): Change[] {
  const cs = { left: chars(pages.left), right: chars(pages.right) };
  const where = { left: locator(comparison.docs.left), right: locator(comparison.docs.right) };

  // The source paragraphs each TeX hunk touches, per side.
  const touched: Record<Side, Map<string, Change["source"]>> = { left: new Map(), right: new Map() };
  for (const [path, diff] of comparison.diffs) {
    for (const hunk of diff.hunks) {
      const source = { path, hunk };
      const add = (side: Side, from: number, to: number) => {
        for (let line = from; line < to; line++) {
          const key = where[side].paragraph(path, line);
          const list = touched[side].get(key) ?? [];
          if (!list.includes(source)) touched[side].set(key, [...list, source]);
        }
      };
      add("left", hunk.leftStart, hunk.leftEnd);
      add("right", hunk.rightStart, hunk.rightEnd);
    }
  }

  const changes: (Change & { keys: Set<string | null> })[] = [];
  diffChars(cs.left, cs.right).forEach((e, edit) => {
    const range = { left: cs.left.slice(e.a0, e.a1), right: cs.right.slice(e.b0, e.b1) };
    const paragraphs = (side: Side) => new Set(range[side].map((c) => where[side].of(c).paragraph));
    const source = (["left", "right"] as const).flatMap((side) => [...paragraphs(side)].flatMap((p) => touched[side].get(p ?? "") ?? []));
    if (!source.length) return;

    // Edits in one paragraph of the right document are one change; removed text between two paragraphs stands alone.
    const keys = paragraphs("right");
    if (!keys.size) {
      const [before, after] = [cs.right[e.b0 - 1], cs.right[e.b0]].map((c) => (c ? where.right.of(c).paragraph : null));
      keys.add(before === after ? before : `between ${before} and ${after}`);
    }
    const marks = (side: Side) => {
      const out: Mark[] = [];
      for (const c of range[side]) {
        const last = out[out.length - 1];
        if (last && last.page === c.page && last.run === c.run.index) last.end = c.offset + c.ch.length;
        else out.push({ page: c.page, run: c.run.index, start: c.offset, end: c.offset + c.ch.length, edit, margin: where[side].of(c).margin });
      }
      return out;
    };
    const last = changes[changes.length - 1];
    if (last && [...keys].some((k) => k !== null && last.keys.has(k))) {
      for (const k of keys) last.keys.add(k);
      last.marks.left.push(...marks("left"));
      last.marks.right.push(...marks("right"));
      for (const s of source) if (!last.source.includes(s)) last.source.push(s);
    } else {
      const position = (side: Side, at: number): Position => {
        const c = cs[side][Math.min(at, cs[side].length - 1)];
        return c ? { page: c.page, y: c.run.y0 } : { page: 1, y: 0 };
      };
      changes.push({
        keys,
        marks: { left: marks("left"), right: marks("right") },
        left: position("left", e.a0),
        right: position("right", e.b0),
        source: [...new Set(source)],
      });
    }
  });
  return changes;
}

/** Where a character comes from: its source paragraph and the left edge of its column, from the synctex boxes around it. */
function locator(doc: Doc) {
  const ids = new Map<string, number[]>();
  // A paragraph is a run of non-blank lines with the blank line that ends it, which is the line TeX attaches its text to.
  const paragraph = (path: string, line: number) => {
    let byLine = ids.get(path);
    if (!byLine) {
      let id = 0;
      byLine = [0, ...(doc.lines.get(path) ?? []).map((l) => (l.trim() === "" ? id++ : id))];
      ids.set(path, byLine);
    }
    return `${path}#${byLine[line] ?? -1}`;
  };
  const byRun = new Map<TextRun, { paragraph: string | null; margin: number }>();
  const of = (c: Char) => {
    let found = byRun.get(c.run);
    if (!found) {
      const [x, y] = [(c.run.x0 + c.run.x1) / 2, (c.run.y0 + c.run.y1) / 2];
      const around = (doc.blocksByPage.get(c.page) ?? []).filter((b) => contains(blockRect(b), x, y));
      const inner = around.reduce<(typeof around)[0] | undefined>((s, b) => (s && s.width * s.height <= b.width * b.height ? s : b), undefined);
      const path = inner && doc.pathByFileId.get(inner.fileId);
      found = {
        paragraph: inner && path ? paragraph(path, inner.line) : null,
        margin: Math.min(c.run.x0, ...around.map((b) => b.left)),
      };
      byRun.set(c.run, found);
    }
    return found;
  };
  return { paragraph, of };
}
