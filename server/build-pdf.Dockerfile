# TeX toolchain for building the Gray Paper. Debian trixie: bookworm's TeX Live is too old for
# the current text (\tl_set:Ne is undefined).
FROM node:22-trixie

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y \
        texlive-xetex texlive-science texlive-bibtex-extra texlive-fonts-extra biber && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# synctex-to-json.ts comes from FluffyLabs/graypaper-archive, used in place so the JSON matches
# the public archive's. Pinned; bump ARCHIVE_REF to update.
ARG ARCHIVE_REF=39519036150c01eb1a2166ef7d3a7e4014335c9b
RUN git clone -q https://github.com/FluffyLabs/graypaper-archive.git /workspace && \
    git -C /workspace checkout -q "$ARCHIVE_REF" && \
    cd /workspace && npm ci --no-audit --no-fund

# ImageMagick shrinks the page background before each build (see build-in-container.sh).
RUN apt-get update && apt-get install -y --no-install-recommends imagemagick && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# pdf.js for extracting each build's text on the server (server/extract-text.ts, mounted at /app).
RUN npm install --prefix /opt/pdfjs --no-audit --no-fund pdfjs-dist@6.0.227
ENV PDFJS_MODULE=/opt/pdfjs/node_modules/pdfjs-dist/legacy/build/pdf.mjs

# The build steps (server/build-in-container.sh) are mounted at /app at run time, not copied in,
# so changing them does not rebuild this image.
WORKDIR /workspace
CMD ["/app/server/build-in-container.sh"]
