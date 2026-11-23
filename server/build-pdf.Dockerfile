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

COPY build-in-container.sh /usr/local/bin/build-in-container.sh
WORKDIR /workspace
CMD ["build-in-container.sh"]
