#!/usr/bin/env bash
# Runs inside the TeX image. Builds /workspace/graypaper (the checked-out commit $VERSION) into
# /workspace/dist as graypaper-$VERSION.pdf, graypaper-$VERSION.synctex.json and tex-$VERSION/.
# The paths matter: synctex-to-json.ts expects sources under /workspace/graypaper.
set -euo pipefail
: "${VERSION:?}"
cd /workspace/graypaper

latex() {
  xelatex -halt-on-error -interaction=nonstopmode -synctex=1 -output-directory ../dist graypaper.tex >/dev/null ||
    { tail -40 ../dist/graypaper.log; exit 1; }
}
latex
biber --output-directory ../dist graypaper >/dev/null
latex
latex

cd /workspace
gzip -df dist/graypaper.synctex.gz
npx tsx scripts/synctex-to-json.ts dist/graypaper.synctex "dist/graypaper-$VERSION.synctex.json"
mv dist/graypaper.pdf "dist/graypaper-$VERSION.pdf"
rm -rf "dist/tex-$VERSION" && mkdir "dist/tex-$VERSION"
(cd graypaper && find . -name '*.tex' -exec cp --parents {} "../dist/tex-$VERSION/" \;)
rm -f dist/graypaper.*
