/** A run of changed lines: `left` lines were replaced by `right` lines (1-based, end exclusive). */
export interface IHunk {
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
}

export interface ILineDiff {
  hunks: IHunk[];
  /** For every unchanged line, its number on the other side (1-based). */
  leftToRight: Map<number, number>;
  rightToLeft: Map<number, number>;
}

/**
 * Line diff of two files via LCS. Common prefix and suffix are stripped first,
 * so the quadratic table only covers the changed middle.
 */
export function diffLines(left: string[], right: string[]): ILineDiff {
  const leftToRight = new Map<number, number>();
  const rightToLeft = new Map<number, number>();
  const pairs: [number, number][] = [];

  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) {
    pairs.push([start, start]);
    start++;
  }
  let leftEnd = left.length;
  let rightEnd = right.length;
  const suffix: [number, number][] = [];
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd--;
    rightEnd--;
    suffix.push([leftEnd, rightEnd]);
  }

  const n = leftEnd - start;
  const m = rightEnd - start;
  if (n > 0 && m > 0) {
    // lcs[i][j] = LCS length of left[start+i..leftEnd) and right[start+j..rightEnd)
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          left[start + i] === right[start + j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (left[start + i] === right[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  }
  pairs.push(...suffix.reverse());

  const hunks: IHunk[] = [];
  let prevLeft = 0;
  let prevRight = 0;
  for (const [l, r] of [...pairs, [left.length, right.length] as [number, number]]) {
    if (l > prevLeft || r > prevRight) {
      hunks.push({ leftStart: prevLeft + 1, leftEnd: l + 1, rightStart: prevRight + 1, rightEnd: r + 1 });
    }
    if (l < left.length) {
      leftToRight.set(l + 1, r + 1);
      rightToLeft.set(r + 1, l + 1);
    }
    prevLeft = l + 1;
    prevRight = r + 1;
  }

  return { hunks, leftToRight, rightToLeft };
}

/** Above this many cells the LCS table is not built and the stretch counts as one replacement. */
const MAX_LCS_CELLS = 4e7;

/**
 * Hunks of two long sequences (patience diff): items that occur once on each side anchor the
 * alignment, and only the stretches between anchors go through the quadratic LCS.
 */
export function diffAnchored(left: string[], right: string[]): IHunk[] {
  const hunks: IHunk[] = [];
  const walk = (l0: number, l1: number, r0: number, r1: number) => {
    while (l0 < l1 && r0 < r1 && left[l0] === right[r0]) {
      l0++;
      r0++;
    }
    while (l1 > l0 && r1 > r0 && left[l1 - 1] === right[r1 - 1]) {
      l1--;
      r1--;
    }
    if (l0 === l1 && r0 === r1) return;
    const anchors = l0 < l1 && r0 < r1 ? uniquePairs(left, l0, l1, right, r0, r1) : [];
    if (anchors.length) {
      for (const [l, r] of [...anchors, [l1, r1]]) {
        walk(l0, l, r0, r);
        l0 = l + 1;
        r0 = r + 1;
      }
    } else if (l0 === l1 || r0 === r1 || (l1 - l0) * (r1 - r0) > MAX_LCS_CELLS) {
      hunks.push({ leftStart: l0 + 1, leftEnd: l1 + 1, rightStart: r0 + 1, rightEnd: r1 + 1 });
    } else {
      for (const h of diffLines(left.slice(l0, l1), right.slice(r0, r1)).hunks) {
        hunks.push({ leftStart: h.leftStart + l0, leftEnd: h.leftEnd + l0, rightStart: h.rightStart + r0, rightEnd: h.rightEnd + r0 });
      }
    }
  };
  walk(0, left.length, 0, right.length);
  return hunks;
}

/** The longest run, in the order of both sides, of items occurring exactly once in each range. */
function uniquePairs(left: string[], l0: number, l1: number, right: string[], r0: number, r1: number) {
  const once = (items: string[], from: number, to: number) => {
    const at = new Map<string, number>();
    for (let i = from; i < to; i++) at.set(items[i], at.has(items[i]) ? -1 : i);
    return at;
  };
  const inLeft = once(left, l0, l1);
  const inRight = once(right, r0, r1);
  const pairs: [number, number][] = [];
  for (let l = l0; l < l1; l++) {
    const r = inLeft.get(left[l]) === l ? (inRight.get(left[l]) ?? -1) : -1;
    if (r >= 0) pairs.push([l, r]);
  }
  // Longest increasing subsequence by right position.
  const tails: number[] = [];
  const previous: number[] = [];
  pairs.forEach(([, r], k) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < r) lo = mid + 1;
      else hi = mid;
    }
    previous[k] = lo ? tails[lo - 1] : -1;
    tails[lo] = k;
  });
  const run: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = previous[k]) run.push(pairs[k]);
  return run.reverse();
}
