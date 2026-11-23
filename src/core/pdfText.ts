import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { TextRun } from "./words";

/** Share of the font size below the baseline, for descenders. */
const DESCENT = 0.25;

/**
 * The page's non-empty text runs with rough boxes (fractions of the page). The boxes only decide
 * which runs belong to a change; exact letter positions come from the rendered text layer.
 */
export async function extractRuns(doc: PDFDocumentProxy, pageNumber: number): Promise<TextRun[]> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const raw of content.items) {
    if (!("str" in raw) || raw.str === "") continue;
    const item = raw as TextItem;
    const size = Math.hypot(item.transform[2], item.transform[3]) || item.height;
    const [x, baseline] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    runs.push({
      index: runs.length,
      text: item.str,
      eol: item.hasEOL,
      x0: x / viewport.width,
      x1: (x + item.width) / viewport.width,
      y0: (baseline - size) / viewport.height,
      y1: (baseline + size * DESCENT) / viewport.height,
    });
  }
  return runs;
}
