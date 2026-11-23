import type { SynctexBlock } from "./compare";

/** A rectangle on a page, in fractions of the page width and height. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Synctex boxes stop at the baseline; extend them over descenders by this share of their height. */
const DEPTH = 0.35;
const PAD = 0.002;
/** Wider than a word space, so marked words on one line form one shape. */
const JOIN_GAP = 0.015;
/** Shapes on one line overlap by at least this share of the lower one's height; lines above each other do not. */
const LINE_OVERLAP = 0.3;

export function blockRect(b: SynctexBlock): Rect {
  return { x0: b.left - PAD, y0: b.top - b.height - PAD, x1: b.left + b.width + PAD, y1: b.top + b.height * DEPTH + PAD };
}

/**
 * Join rectangles, given in reading order, that sit on the same line and nearly touch, so a
 * base letter and its sub- and superscripts are one shape.
 */
export function mergeRects(input: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of input) {
    const near = out.findLast((o) => {
      const overlap = Math.min(o.y1, r.y1) - Math.max(o.y0, r.y0);
      return r.x0 < o.x1 + JOIN_GAP && o.x0 < r.x1 + JOIN_GAP && overlap >= LINE_OVERLAP * Math.min(o.y1 - o.y0, r.y1 - r.y0);
    });
    if (!near) out.push({ ...r });
    else Object.assign(near, { x0: Math.min(near.x0, r.x0), y0: Math.min(near.y0, r.y0), x1: Math.max(near.x1, r.x1), y1: Math.max(near.y1, r.y1) });
  }
  return out;
}

export function contains(rect: Rect, x: number, y: number) {
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}
