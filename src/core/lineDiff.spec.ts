import { describe, expect, it } from "vitest";
import { diffAnchored, diffLines } from "./lineDiff";

describe("diffLines", () => {
  it("finds no hunks for equal files", () => {
    const { hunks, leftToRight } = diffLines(["a", "b"], ["a", "b"]);
    expect(hunks).toEqual([]);
    expect([...leftToRight]).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("reports a replaced line", () => {
    const { hunks, leftToRight, rightToLeft } = diffLines(["a", "b", "c"], ["a", "x", "c"]);
    expect(hunks).toEqual([{ leftStart: 2, leftEnd: 3, rightStart: 2, rightEnd: 3 }]);
    expect(leftToRight.get(3)).toBe(3);
    expect(rightToLeft.has(2)).toBe(false);
  });

  it("reports insertions and deletions with shifted line numbers", () => {
    const { hunks, leftToRight } = diffLines(["a", "b", "c", "d"], ["a", "new", "b", "d"]);
    expect(hunks).toEqual([
      { leftStart: 2, leftEnd: 2, rightStart: 2, rightEnd: 3 },
      { leftStart: 3, leftEnd: 4, rightStart: 4, rightEnd: 4 },
    ]);
    expect(leftToRight.get(2)).toBe(3);
    expect(leftToRight.get(4)).toBe(4);
  });

  it("handles a file that only exists on one side", () => {
    expect(diffLines([], ["a", "b"]).hunks).toEqual([{ leftStart: 1, leftEnd: 1, rightStart: 1, rightEnd: 3 }]);
    expect(diffLines(["a"], []).hunks).toEqual([{ leftStart: 1, leftEnd: 2, rightStart: 1, rightEnd: 1 }]);
  });
});

describe("diffAnchored", () => {
  it("finds the same hunks as diffLines around items that occur once", () => {
    const left = "the cat sat on the mat and the dog ran".split(" ");
    const right = "the cat lay on the mat and then the dog ran off".split(" ");
    expect(diffAnchored(left, right)).toEqual(diffLines(left, right).hunks);
    expect(diffAnchored(left, left)).toEqual([]);
  });
});
