import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { archiveUrls } from "../core/archive";
import { type Comparison, compareDocs, loadDoc, type Position, type Side } from "../core/compare";
import { type Change, findChanges, type Mark } from "../core/words";
import { PdfPane, type PdfPaneHandle } from "./PdfPane";
import { extractRuns } from "../core/pdfText";
import type { TextRun } from "../core/words";
import { type BuildStatus, useBuild } from "./useBuild";

const ARCHIVE = "/archive";
const COLORS: Record<Side, string> = { left: "#ff5c5c", right: "#3ddc84" };
const JUMP_MARGIN_PX = 80;

interface Refs {
  left: string;
  right: string;
}

/** `?left=<ref>&right=<ref>`, or `?pr=<n>` for a pull request against the commit it branched from. */
function readRefs(): Refs {
  const params = new URLSearchParams(window.location.search);
  const pr = params.get("pr");
  if (pr) return { left: `pr/${pr}-base`, right: `pr/${pr}` };
  return { left: params.get("left") ?? "", right: params.get("right") ?? "" };
}

/** "PR #590 · GP compare", "v0.7.2 → v0.8.0 · GP compare", or just the name. */
function pageTitle({ left, right }: Refs) {
  const pr = right.match(/^pr\/(\d+)$/)?.[1];
  const what = pr && left === `pr/${pr}-base` ? `PR #${pr}` : left && right ? `${left} → ${right}` : "";
  return what ? `${what} · GP compare` : "GP compare";
}

function writeRefs(refs: Refs) {
  const params = new URLSearchParams();
  if (refs.left) params.set("left", refs.left);
  if (refs.right) params.set("right", refs.right);
  window.history.pushState(null, "", `?${params}`);
}

export function App() {
  const [refs, setRefs] = useState<Refs>(readRefs);
  const [draft, setDraft] = useState<Refs>(refs);
  const [linked, setLinked] = useState(true);
  const [showHighlights, setShowHighlights] = useState(true);
  const [showSource, setShowSource] = useState(true);
  const [current, setCurrent] = useState(-1);

  useEffect(() => {
    const onPop = () => {
      const next = readRefs();
      setPdfs({});
      setRefs(next);
      setDraft(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const left = useBuild(refs.left);
  const right = useBuild(refs.right);
  const comparison = useComparison(left, right);
  const [pdfs, setPdfs] = useState<Partial<Record<Side, PDFDocumentProxy>>>({});
  const shas = useMemo(
    () => ({ left: left?.state === "ready" ? left.sha : undefined, right: right?.state === "ready" ? right.sha : undefined }),
    [left, right],
  );
  const { changes: found, progress } = useChanges(comparison, shas, pdfs);
  const changes = useMemo(() => found ?? [], [found]);
  const marks = useMemo(() => marksByPage(changes), [changes]);

  const panes = { left: useRef<PdfPaneHandle>(null), right: useRef<PdfPaneHandle>(null) };

  const compare = (next: Refs) => {
    writeRefs(next);
    setPdfs({});
    setRefs(next);
    setCurrent(-1);
  };

  const follow = useCallback(
    (from: Side, position: Position) => {
      setCurrent(currentChange(changes, from, position));
      if (!linked || !comparison) return;
      const to: Side = from === "left" ? "right" : "left";
      const target = comparison.mapPosition(from, position);
      if (target) panes[to].current?.scrollToPosition(target);
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: pane refs are stable
    [linked, comparison, changes],
  );

  const goTo = useCallback(
    (index: number) => {
      const change = changes[index];
      if (!change) return;
      setCurrent(index);
      for (const side of ["left", "right"] as const) panes[side].current?.scrollToPosition(change[side], JUMP_MARGIN_PX);
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: pane refs are stable
    [changes],
  );
  const jump = (direction: 1 | -1) => goTo(Math.min(Math.max(current + direction, 0), changes.length - 1));

  // ?change=N opens at that change once both documents are on screen.
  const linkedChange = useRef(Number(new URLSearchParams(window.location.search).get("change")) || 0);
  useEffect(() => {
    if (!linkedChange.current || !changes.length || !pdfs.left || !pdfs.right) return;
    const index = linkedChange.current - 1;
    linkedChange.current = 0;
    setTimeout(() => goTo(index), 300); // let pdf.js lay out the pages first
  }, [changes, pdfs.left, pdfs.right, goTo]);

  // Keep ?change= on the current change, so the address can be shared as is.
  useEffect(() => {
    if (current < 0) return;
    const url = new URL(window.location.href);
    url.searchParams.set("change", String(current + 1));
    window.history.replaceState(null, "", url);
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "]" || e.key === "n") jump(1);
      if (e.key === "[" || e.key === "p") jump(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump]);

  useEffect(() => {
    document.title = pageTitle(refs);
  }, [refs]);

  const suggestions = useRefSuggestions();

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="title">
          <img src="/favicon.svg" alt="" width="20" height="20" />
          GP compare
        </strong>
        <form
          className="refs"
          onSubmit={(e) => {
            e.preventDefault();
            compare(draft);
          }}
        >
          <RefInput label="Left" value={draft.left} onChange={(left) => setDraft({ ...draft, left })} />
          <button
            type="button"
            title="Swap sides"
            onClick={() => {
              const swapped = { left: draft.right, right: draft.left };
              setDraft(swapped);
              compare(swapped);
            }}
          >
            ⇄
          </button>
          <RefInput label="Right" value={draft.right} onChange={(right) => setDraft({ ...draft, right })} />
          <button type="submit" className="primary">
            Compare
          </button>
        </form>
        <div className="nav">
          <button type="button" onClick={() => jump(-1)} disabled={!changes.length} title="Previous change ( [ or p )">
            ◀
          </button>
          <span className="counter">
            {found
              ? `${current >= 0 ? current + 1 : "–"} / ${changes.length} changes`
              : shas.left && shas.right
                ? progress !== null
                  ? `Comparing… ${Math.round(100 * progress)}%`
                  : "Comparing…"
                : ""}
          </span>
          <button type="button" onClick={() => jump(1)} disabled={!changes.length} title="Next change ( ] or n )">
            ▶
          </button>
        </div>
        <label title="Scroll both sides together. Hold Shift while scrolling to move one side alone.">
          <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} /> Link scrolling
        </label>
        <label>
          <input type="checkbox" checked={showHighlights} onChange={(e) => setShowHighlights(e.target.checked)} />{" "}
          Highlights
        </label>
        <label>
          <input type="checkbox" checked={showSource} onChange={(e) => setShowSource(e.target.checked)} /> Source
        </label>
        <nav className="links">
          <a href="https://github.com/daiagi/gp-compare/issues/new" target="_blank" rel="noreferrer">
            Report an issue
          </a>
          <a href="https://github.com/daiagi/gp-compare" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
        <datalist id="refs">
          {suggestions.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </datalist>
      </header>

      <main className="panes">
        {(["left", "right"] as const).map((side) => {
          const status = side === "left" ? left : right;
          return (
            <section key={side} className={`pane pane-${side}`}>
              <PaneHeader status={status} side={side} />
              {status?.state === "ready" && status.sha ? (
                <PdfPane
                  ref={panes[side]}
                  url={archiveUrls(ARCHIVE, status.sha).pdf}
                  marks={showHighlights ? marks[side] : null}
                  onDocument={(doc) => setPdfs((prev) => ({ ...prev, [side]: doc }))}
                  color={COLORS[side]}
                  onUserScroll={(position) => follow(side, position)}
                />
              ) : (
                <PaneMessage status={status} />
              )}
            </section>
          );
        })}
      </main>

      {showSource && changes[current] && <SourcePanel change={changes[current]} comparison={comparison} />}
    </div>
  );
}

function RefInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="ref">
      {label}
      <input
        list="refs"
        value={value}
        placeholder="v0.8.0, main, sha, pr/590, pr/590-base"
        onChange={(e) => onChange(e.target.value.trim())}
        spellCheck={false}
      />
    </label>
  );
}

function PaneHeader({ status, side }: { status: BuildStatus | null; side: Side }) {
  if (!status?.sha) return <div className={`pane-header pane-header-${side}`}>{status?.ref || "no version"}</div>;
  const pr = status.ref.match(/^pr\/(\d+)/)?.[1];
  return (
    <div className={`pane-header pane-header-${side}`}>
      <span>{status.label}</span>
      <a href={`https://github.com/gavofyork/graypaper/commit/${status.sha}`} target="_blank" rel="noreferrer">
        {status.sha.slice(0, 7)}
      </a>
      {pr && (
        <a href={`https://github.com/gavofyork/graypaper/pull/${pr}`} target="_blank" rel="noreferrer">
          PR #{pr}
        </a>
      )}
    </div>
  );
}

function PaneMessage({ status }: { status: BuildStatus | null }) {
  if (!status) return <div className="pane-message">Pick a version above.</div>;
  if (status.state === "resolving") return <div className="pane-message">Looking up {status.ref}…</div>;
  if (status.state === "building") return <BuildProgress status={status} />;
  return (
    <div className="pane-message error">
      Could not load {status.ref}.<pre>{status.log}</pre>
    </div>
  );
}

/** "Building PR #590 · 1:12 · step 3/5 typesetting again (references)", updated every second. */
function BuildProgress({ status }: { status: BuildStatus }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - (status.since ?? now)) / 1000));
  const step = status.progress?.match(/^(\d+)\/(\d+) (.*)$/);
  return (
    <div className="pane-message">
      <div>
        Building {status.label ?? status.ref} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </div>
      {step ? (
        <>
          <progress max={Number(step[2])} value={Number(step[1]) - 0.5} />
          <div className="muted">
            step {step[1]} of {step[2]}: {step[3]}
          </div>
        </>
      ) : (
        <div className="muted">{status.progress || "starting"}</div>
      )}
      <div className="muted">A new version takes about a minute; after that it opens at once.</div>
    </div>
  );
}

function SourcePanel({ change, comparison }: { change: Change; comparison: Comparison | null }) {
  const lines = (side: Side, path: string, start: number, end: number) =>
    comparison?.docs[side].lines.get(path)?.slice(start - 1, end - 1) ?? [];
  return (
    <footer className="source">
      {change.source.map(({ path, hunk }) => (
        <div key={`${path}:${hunk.rightStart}`}>
          <div className="source-path">
            {path}:{hunk.rightStart}
          </div>
          <pre>
            {lines("left", path, hunk.leftStart, hunk.leftEnd).map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are static
              <div key={`-${i}`} className="del">
                - {line}
              </div>
            ))}
            {lines("right", path, hunk.rightStart, hunk.rightEnd).map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are static
              <div key={`+${i}`} className="add">
                + {line}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </footer>
  );
}

/** The changes, once the text of both PDFs has been read. */
/**
 * The changes, once the text of both versions is known; meanwhile how many pages have been read.
 * The text comes ready-made from the server when it has it, else it is read from the PDF here.
 */
function useChanges(
  comparison: Comparison | null,
  shas: Partial<Record<Side, string>>,
  pdfs: Partial<Record<Side, PDFDocumentProxy>>,
) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [text, setText] = useState<Partial<Record<Side, TextRun[][]>>>({});
  const [pagesRead, setPagesRead] = useState(0);

  // Ready-made text from the server.
  useEffect(() => {
    setText({});
    setPagesRead(0);
    let cancelled = false;
    for (const side of ["left", "right"] as const) {
      const sha = shas[side];
      if (!sha) continue;
      fetch(archiveUrls(ARCHIVE, sha).text)
        .then((r) => (r.ok ? r.json() : null))
        .then((pages: TextRun[][] | null) => {
          if (pages && !cancelled) setText((t) => ({ ...t, [side]: t[side] ?? pages }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [shas.left, shas.right]);

  // Otherwise read it from the PDF once that has loaded.
  useEffect(() => {
    let cancelled = false;
    for (const side of ["left", "right"] as const) {
      const pdf = pdfs[side];
      if (!pdf || text[side]) continue;
      Promise.all(
        Array.from({ length: pdf.numPages }, (_, i) =>
          extractRuns(pdf, i + 1).then((runs) => {
            if (!cancelled) setPagesRead((n) => n + 1);
            return runs;
          }),
        ),
      ).then((pages) => {
        if (!cancelled) setText((t) => ({ ...t, [side]: t[side] ?? pages }));
      });
    }
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: only when a PDF arrives, not when text does
  }, [pdfs.left, pdfs.right]);

  useEffect(() => {
    setChanges(null);
    if (comparison && text.left && text.right) setChanges(findChanges(comparison, { left: text.left, right: text.right }));
  }, [comparison, text.left, text.right]);

  const toRead = (["left", "right"] as const).reduce((n, side) => n + (text[side] ? 0 : (pdfs[side]?.numPages ?? 0)), 0);
  return { changes, progress: toRead ? Math.min(1, pagesRead / toRead) : null };
}

function marksByPage(changes: Change[]): Record<Side, Map<number, Mark[]>> {
  const forSide = (side: Side) => {
    const pages = new Map<number, Mark[]>();
    for (const mark of changes.flatMap((c) => c.marks[side])) {
      const marks = pages.get(mark.page) ?? [];
      if (!marks.length) pages.set(mark.page, marks);
      marks.push(mark);
    }
    return pages;
  };
  return { left: forSide("left"), right: forSide("right") };
}

function useComparison(left: BuildStatus | null, right: BuildStatus | null): Comparison | null {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const leftSha = left?.state === "ready" ? left.sha : undefined;
  const rightSha = right?.state === "ready" ? right.sha : undefined;

  useEffect(() => {
    setComparison(null);
    if (!leftSha || !rightSha) return;
    let cancelled = false;
    const load = (sha: string) => {
      const urls = archiveUrls(ARCHIVE, sha);
      return loadDoc(urls.synctex, urls.tex);
    };
    Promise.all([load(leftSha), load(rightSha)]).then(([l, r]) => {
      if (cancelled) return;
      setComparison(compareDocs(l, r));
    });
    return () => {
      cancelled = true;
    };
  }, [leftSha, rightSha]);

  return comparison;
}

/** The last change at or above the given place. */
function currentChange(changes: Change[], side: Side, position: Position) {
  let index = -1;
  changes.forEach((change, i) => {
    const p = change[side];
    if (p.page < position.page || (p.page === position.page && p.y <= position.y + 0.02)) index = i;
  });
  return index;
}

function useRefSuggestions() {
  const [refs, setRefs] = useState<{ tags: string[]; branches: string[]; pulls: { number: number; title: string }[] }>();
  useEffect(() => {
    // Suggestions are optional: if the list can't be loaded (e.g. GitHub rate limit), just show none.
    fetch("/api/refs")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => body?.tags && body?.pulls && setRefs(body))
      .catch(() => {});
  }, []);
  return useMemo(() => {
    if (!refs) return [];
    return [
      ...refs.branches.map((b) => ({ value: b, label: "branch" })),
      ...refs.tags.map((t) => ({ value: t, label: "release" })),
      ...refs.pulls.flatMap((p) => [
        { value: `pr/${p.number}`, label: `#${p.number} ${p.title}` },
        { value: `pr/${p.number}-base`, label: `base of #${p.number}` },
      ]),
    ];
  }, [refs]);
}
