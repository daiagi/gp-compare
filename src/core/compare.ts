/**
 * Compare two builds of the Gray Paper. Framework-free: it only needs each build's synctex
 * JSON and TeX sources, so any viewer that has those can use it.
 *
 * The TeX sources are diffed line by line; synctex maps each line to the boxes it produced on
 * the page. Unchanged lines tie the two documents together for scrolling, and changed lines say
 * where a difference on the page is a real edit (words.ts).
 */
import { diffLines, type ILineDiff } from "./lineDiff";

export type Side = "left" | "right";

export interface SynctexBlock {
  fileId: number;
  line: number;
  pageNumber: number;
  index: number;
  /** Fractions of the page. `top` is the baseline; the box spans [top - height, top]. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SynctexJson {
  files: Record<string, string>;
  pages: Record<string, SynctexBlock[]>;
}

/** One build: its synctex map and the lines of every TeX file it was made from. */
export interface Doc {
  pathByFileId: Map<number, string>;
  fileIdByPath: Map<string, number>;
  blocksByPage: Map<number, SynctexBlock[]>;
  blocksByLine: Map<string, SynctexBlock[]>;
  lines: Map<string, string[]>;
}

/** A place in a document: page number and the fraction of the page height from its top. */
export interface Position {
  page: number;
  y: number;
}

export interface Comparison {
  docs: Record<Side, Doc>;
  /** The line diff of every TeX file, by path. */
  diffs: Map<string, ILineDiff>;
  /** The place in the other document showing the same content as `position` in `from`. */
  mapPosition(from: Side, position: Position): Position | null;
}

const MAX_LINE_SEARCH = 200;

export async function loadDoc(synctexUrl: string, texUrl: (path: string) => string): Promise<Doc> {
  const json = (await (await fetch(synctexUrl)).json()) as SynctexJson;
  const pathByFileId = new Map<number, string>();
  const fileIdByPath = new Map<string, number>();
  for (const [id, path] of Object.entries(json.files)) {
    if (!path.endsWith(".tex")) continue;
    pathByFileId.set(Number(id), path);
    fileIdByPath.set(path, Number(id));
  }
  const blocksByPage = new Map<number, SynctexBlock[]>();
  const blocksByLine = new Map<string, SynctexBlock[]>();
  for (const [page, blocks] of Object.entries(json.pages)) {
    const usable = blocks.filter(isUsable);
    blocksByPage.set(Number(page), usable);
    for (const block of usable) {
      const key = lineKey(block.fileId, block.line);
      const list = blocksByLine.get(key) ?? [];
      list.push(block);
      blocksByLine.set(key, list);
    }
  }
  const lines = new Map(
    await Promise.all(
      [...fileIdByPath.keys()].map(async (path) => {
        const response = await fetch(texUrl(path));
        return [path, response.ok ? (await response.text()).split("\n") : []] as const;
      }),
    ),
  );
  return { pathByFileId, fileIdByPath, blocksByPage, blocksByLine, lines };
}

export function compareDocs(left: Doc, right: Doc): Comparison {
  const docs: Record<Side, Doc> = { left, right };
  const diffs = new Map<string, ILineDiff>();
  for (const path of new Set([...left.lines.keys(), ...right.lines.keys()])) {
    diffs.set(path, diffLines(left.lines.get(path) ?? [], right.lines.get(path) ?? []));
  }

  const mapPosition = (from: Side, position: Position): Position | null => {
    const to: Side = from === "left" ? "right" : "left";
    const source = docs[from];
    const target = docs[to];
    const blocks = source.blocksByPage.get(position.page) ?? [];
    if (!blocks.length) return null;

    // Anchor on the first box at or below the given point.
    const below = blocks.filter((b) => boxTop(b) >= position.y);
    const anchor = below.length
      ? below.reduce((a, b) => (boxTop(b) < boxTop(a) ? b : a))
      : blocks.reduce((a, b) => (boxTop(b) > boxTop(a) ? b : a));
    const path = source.pathByFileId.get(anchor.fileId);
    const diff = path && diffs.get(path);
    if (!path || !diff) return null;
    const lineMap = from === "left" ? diff.leftToRight : diff.rightToLeft;

    for (let offset = 0; offset < MAX_LINE_SEARCH; offset++) {
      for (const line of offset ? [anchor.line + offset, anchor.line - offset] : [anchor.line]) {
        const mapped = lineMap.get(line);
        if (mapped === undefined) continue;
        const candidates = blocksOf(target, path, mapped);
        if (!candidates.length) continue;
        if (line !== anchor.line) return { page: candidates[0].pageNumber, y: boxTop(candidates[0]) };
        // One line can own a whole paragraph of boxes: take the box in the same place in that run.
        const ordinal = blocksOf(source, path, line).indexOf(anchor);
        const match = candidates[Math.min(Math.max(ordinal, 0), candidates.length - 1)];
        return { page: match.pageNumber, y: boxTop(match) - (boxTop(anchor) - position.y) };
      }
    }
    return null;
  };

  return { docs, diffs, mapPosition };
}

function blocksOf(doc: Doc, path: string, line: number): SynctexBlock[] {
  const fileId = doc.fileIdByPath.get(path);
  return fileId === undefined ? [] : (doc.blocksByLine.get(lineKey(fileId, line)) ?? []);
}

function lineKey(fileId: number, line: number) {
  return `${fileId}:${line}`;
}

function boxTop(block: SynctexBlock) {
  return block.top - block.height;
}

/** Synctex also emits zero-size marks and boxes spanning whole pages; neither is useful to highlight. */
function isUsable(block: SynctexBlock) {
  return block.width > 0 && block.height > 0 && block.height <= 0.15 && block.width <= 0.95;
}
