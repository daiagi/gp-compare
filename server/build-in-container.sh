#!/usr/bin/env bash
# Runs inside the TeX image. Builds /workspace/graypaper (the checked-out commit $VERSION) into
# /workspace/dist as graypaper-$VERSION.pdf, graypaper-$VERSION.synctex.json and tex-$VERSION/.
# The paths matter: synctex-to-json.ts expects sources under /workspace/graypaper.
# With TEXT_FROM=<pdf> it only extracts that PDF's text (for versions built elsewhere).
set -euo pipefail
: "${VERSION:?}"
# Each step writes its name to dist/.progress-$VERSION, which the server reports while building.
step() { echo "$1" > "/workspace/dist/.progress-$VERSION"; }
text() { /workspace/node_modules/.bin/tsx /app/server/extract-text.mts "$1" "/workspace/dist/graypaper-$VERSION.text.json"; }
if [ -n "${TEXT_FROM:-}" ]; then text "$TEXT_FROM"; exit; fi
cd /workspace/graypaper

# The page background is two 25-megapixel PNGs, which the PDF step re-encodes for every page:
# minutes per build. Small JPEG copies, found first through TEXINPUTS, look the same on screen
# and take about a second. The checkout itself is left untouched.
mkdir -p /tmp/background/assets
magick=$(command -v magick || command -v convert)
for image in assets/grayl.png assets/grayr.png; do
  if [ -f "$image" ]; then "$magick" "$image" -resize 900x -quality 60 "jpeg:/tmp/background/$image"; fi
done
export TEXINPUTS=/tmp/background//:

# Only the last pass writes a PDF; the earlier ones are for references.
latex() {
  xelatex -halt-on-error -interaction=nonstopmode -synctex=1 -output-directory ../dist "$@" graypaper.tex >/dev/null ||
    { tail -40 ../dist/graypaper.log; exit 1; }
}
step "1/5 typesetting"
latex -no-pdf
step "2/5 bibliography"
biber --output-directory ../dist graypaper >/dev/null
step "3/5 typesetting again (references)"
latex -no-pdf
latex

cd /workspace
step "4/5 page map"
gzip -df dist/graypaper.synctex.gz
npx tsx scripts/synctex-to-json.ts dist/graypaper.synctex "dist/graypaper-$VERSION.synctex.json"
mv dist/graypaper.pdf "dist/graypaper-$VERSION.pdf"
step "5/5 text"
text "dist/graypaper-$VERSION.pdf"
rm -rf "dist/tex-$VERSION" && mkdir "dist/tex-$VERSION"
(cd graypaper && find . -name '*.tex' -exec cp --parents {} "../dist/tex-$VERSION/" \;)
rm -f dist/graypaper.* "dist/.progress-$VERSION"
