import "pdfjs-dist/web/pdf_viewer.css";
import * as pdfjs from "pdfjs-dist";
import * as pdfjsViewer from "pdfjs-dist/web/pdf_viewer.mjs";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Position } from "../core/compare";
import { mergeRects, type Rect } from "../core/geometry";
import type { Mark } from "../core/words";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

export interface PdfPaneHandle {
  /** The position at the top of the viewport. */
  getPosition(): Position | null;
  scrollToPosition(position: Position, margin?: number): void;
}

interface Props {
  url: string;
  /** The characters that differ, by page. */
  marks: Map<number, Mark[]> | null;
  color: string;
  onDocument?: (doc: PDFDocumentProxy) => void;
  /** Called when the user scrolls this pane, unless Shift is held (Shift scrolls it alone). */
  onUserScroll: (position: Position) => void;
}

/** One PDF, fitted to the pane's width, with the changed characters marked on its pages. */
export const PdfPane = forwardRef<PdfPaneHandle, Props>(function PdfPane({ url, marks, color, onDocument, onUserScroll }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<pdfjsViewer.PDFViewer | null>(null);
  const ignoreScroll = useRef(false);
  const marksRef = useRef(marks);
  const onUserScrollRef = useRef(onUserScroll);
  onUserScrollRef.current = onUserScroll;
  const onDocumentRef = useRef(onDocument);
  onDocumentRef.current = onDocument;

  useImperativeHandle(ref, () => ({
    getPosition() {
      const viewer = viewerRef.current;
      const container = containerRef.current;
      return viewer && container ? positionAt(viewer, container.scrollTop) : null;
    },
    scrollToPosition(position, margin = 0) {
      const page = viewerRef.current?.getPageView(position.page - 1)?.div as HTMLElement | undefined;
      const container = containerRef.current;
      if (!page || !container) return;
      ignoreScroll.current = true;
      container.scrollTop = page.offsetTop + position.y * page.offsetHeight - margin;
      requestAnimationFrame(() => {
        ignoreScroll.current = false;
      });
    },
  }));

  // Load the document.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '<div class="pdfViewer"></div>';
    const eventBus = new pdfjsViewer.EventBus();
    const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
    const viewer = new pdfjsViewer.PDFViewer({
      container,
      viewer: container.firstElementChild as HTMLDivElement,
      eventBus,
      linkService,
    });
    linkService.setViewer(viewer);
    viewerRef.current = viewer;

    eventBus.on("pagesinit", () => {
      viewer.currentScaleValue = "page-width";
    });
    eventBus.on("textlayerrendered", ({ pageNumber, source }: { pageNumber: number; source: PageView }) => {
      drawMarks(source, marksRef.current?.get(pageNumber), color);
    });
    const resize = new ResizeObserver(() => {
      if (viewer.pagesCount) viewer.currentScaleValue = "page-width";
    });
    resize.observe(container);

    let cancelled = false;
    const task = pdfjs.getDocument({ url });
    task.promise.then((doc) => {
      if (cancelled) return;
      viewer.setDocument(doc);
      linkService.setDocument(doc);
      onDocumentRef.current?.(doc);
    });
    return () => {
      cancelled = true;
      resize.disconnect();
      task.destroy();
      viewer.cleanup();
      viewerRef.current = null;
    };
  }, [url, color]);

  // Redraw the marks on the pages already rendered when they change.
  useEffect(() => {
    marksRef.current = marks;
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (let i = 0; i < viewer.pagesCount; i++) {
      const view = viewer.getPageView(i) as PageView | undefined;
      if (view?.div) drawMarks(view, marks?.get(i + 1), color);
    }
  }, [marks, color]);

  // Report scrolls; Shift + wheel scrolls this pane alone. Browsers turn Shift + wheel into
  // horizontal scrolling, so do the vertical scroll here and keep it from being reported.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      const viewer = viewerRef.current;
      if (ignoreScroll.current || !viewer) return;
      const position = positionAt(viewer, container.scrollTop);
      if (position) onUserScrollRef.current(position);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      ignoreScroll.current = true;
      const delta = e.deltaY || e.deltaX;
      container.scrollTop += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? delta * 16 : delta;
      requestAnimationFrame(() => {
        ignoreScroll.current = false;
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
    };
  }, []);

  return <div className="pdf-pane" ref={containerRef} />;
});

function positionAt(viewer: pdfjsViewer.PDFViewer, scrollTop: number): Position | null {
  for (let i = 0; i < viewer.pagesCount; i++) {
    const div = viewer.getPageView(i)?.div as HTMLElement | undefined;
    if (div && div.offsetTop + div.offsetHeight > scrollTop) {
      return { page: i + 1, y: (scrollTop - div.offsetTop) / div.offsetHeight };
    }
  }
  return null;
}

const BAR_OFFSET = 0.008;
const BAR_WIDTH = 0.003;
/** Keeps the bar beside a lone subscript visible. */
const BAR_PAD = 0.003;

interface PageView {
  div: HTMLElement;
  textLayer?: { div?: HTMLElement } | null;
}

/**
 * Mark exact characters, measured on the rendered text layer: one shape per edit and line, with a
 * change bar in the margin beside it. The shapes sit under one translucent layer, so overlaps don't
 * add up into darker bands. Placed in percentages of the page, so zoom needs no redraw.
 */
function drawMarks(view: PageView, marks: Mark[] | undefined, color: string) {
  view.div.querySelector(":scope > .diff-layer")?.remove();
  const textLayer = view.textLayer?.div;
  if (!marks?.length || !textLayer) return;
  const spans = [...textLayer.querySelectorAll("span")].filter((s) => !s.classList.contains("markedContent"));
  const page = view.div.getBoundingClientRect();
  const edits = new Map<number, { margin: number; rects: Rect[] }>();
  for (const mark of marks) {
    const node = spans[mark.run]?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const range = document.createRange();
    range.setStart(node, Math.min(mark.start, node.textContent?.length ?? 0));
    range.setEnd(node, Math.min(mark.end, node.textContent?.length ?? 0));
    const edit = edits.get(mark.edit) ?? { margin: mark.margin, rects: [] };
    edits.set(mark.edit, edit);
    edit.margin = Math.min(edit.margin, mark.margin);
    for (const r of range.getClientRects()) {
      edit.rects.push({
        x0: (r.left - page.left) / page.width,
        y0: (r.top - page.top) / page.height,
        x1: (r.right - page.left) / page.width,
        y1: (r.bottom - page.top) / page.height,
      });
    }
  }
  const layer = document.createElement("div");
  layer.className = "diff-layer";
  const shapes = document.createElement("div");
  shapes.className = "diff-marks";
  for (const { margin, rects } of edits.values()) {
    for (const r of mergeRects(rects)) {
      shapes.appendChild(box(r, color));
      layer.appendChild(box({ x0: margin - BAR_OFFSET, y0: r.y0 - BAR_PAD, x1: margin - BAR_OFFSET + BAR_WIDTH, y1: r.y1 + BAR_PAD }, color));
    }
  }
  layer.prepend(shapes);
  view.div.appendChild(layer);
}

function box(r: Rect, color: string) {
  const div = document.createElement("div");
  div.style.cssText = `left:${r.x0 * 100}%;top:${r.y0 * 100}%;width:${(r.x1 - r.x0) * 100}%;height:${(r.y1 - r.y0) * 100}%;background:${color}`;
  return div;
}
