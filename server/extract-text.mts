// Write a PDF's text runs as JSON (one array per page), so the app need not extract them itself:
//   tsx server/extract-text.mts <in.pdf> <out.text.json>
// PDFJS_MODULE points at pdfjs-dist's legacy build when it is not resolvable from here.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { extractRuns } from "../src/core/pdfText.ts";

const [input, output] = process.argv.slice(2);
const pdfjs = await import(process.env.PDFJS_MODULE ?? "pdfjs-dist/legacy/build/pdf.mjs");
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(input)), verbosity: 0 }).promise;
const pages = [];
for (let page = 1; page <= pdf.numPages; page++) pages.push(await extractRuns(pdf, page));
// Five decimals of a page is well under a pixel and halves the file.
const round = (_: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e5) / 1e5 : v);
writeFileSync(`${output}.part`, JSON.stringify(pages, round));
renameSync(`${output}.part`, output);
