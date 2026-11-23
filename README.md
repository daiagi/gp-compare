# gp-compare

Compare any two Gray Paper versions side by side, rendered, with the changes highlighted:
removed in red on the left, added in green on the right.

```
http://localhost:5174/?left=v0.7.2&right=v0.8.0
http://localhost:5174/?left=pr/590-base&right=pr/590
http://localhost:5174/?pr=590                 # same as the line above
http://localhost:5174/?left=main&right=8c305b5
```

A ref is a tag, a branch of gavofyork/graypaper, a commit, `pr/N` (the PR head) or `pr/N-base`
(the commit the PR branched from). Released versions load from the public Gray Paper archive
at gp.fluffylabs.dev; anything else is built locally on first use and cached.

- Both sides scroll together and stay on the same content. Shift + wheel scrolls one side alone.
- `]` / `n` and `[` / `p` (or the arrows) jump to the next and previous change.
- The Source panel shows the TeX lines of the current change.

## Run

```sh
npm install
npm run server     # backend on :8787 (builds, PDFs and sources, ref list)
npm run dev        # app on :5174
```

Needs Docker (the TeX image is about 5 GB, built on the first build), `git` and `gh` (for the
PR list and `pr/N-base`).

## Layout

- `src/core/`: the comparison, with no UI and no framework. `loadDoc` reads a build's synctex
  JSON and TeX sources; `compareDocs` returns the line diffs and `mapPosition` for scroll sync;
  `findChanges` takes the text runs of both PDFs and returns the changes with their marks.
- `src/ui/`: the React app, two pdf.js panes and the toolbar.
- `server/`: `server.py` (API and build files) and `gp-build.sh` (builds one ref).
- `workspace/`: mounted into the TeX container. Its `scripts/` are copied unchanged from
  FluffyLabs/graypaper-archive, so local builds have the same layout as the public archive:
  `graypaper-<sha>.pdf`, `graypaper-<sha>.synctex.json` and `tex-<sha>/`.
  `server/build-pdf.Dockerfile` uses Debian trixie, because bookworm's TeX Live is too old for
  the current Gray Paper (`\tl_set:Ne` is undefined).

## How the diff works

Each build is a PDF, a synctex map from TeX source lines to boxes on the pages, and the TeX
sources.

1. The rendered text of the two PDFs is diffed as a whole, word by word and then character by
   character, so `N` → `N₁` marks only the `1`. Whitespace, line breaks and hyphens are not
   compared, so reflowed text doesn't show as changed.
2. The TeX sources are diffed line by line. A difference on the page counts only if synctex places
   it in a source paragraph that changed, which leaves out renumbered equations and footnotes
   that moved to another page; a source edit that renders the same is not a change either.
   Unchanged lines tie the two documents together for scrolling.
3. The differences in one source paragraph are one change. The exact characters are measured on
   pdf.js's text layer and get a bar in the margin.

The tests in `src/core/words.spec.ts` check these rules on PR #590 of gavofyork/graypaper.

Because `src/core` only needs those three files per version, another Gray Paper viewer that
has them can reuse it as is.
