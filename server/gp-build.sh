#!/usr/bin/env bash
# Build any Gray Paper commit into workspace/dist, in the same layout as the public archive
# (graypaper-<sha>.pdf, graypaper-<sha>.synctex.json, tex-<sha>/), so the reader can open it.
#
#   gp-build.sh v0.7.2          a tag
#   gp-build.sh 8c305b5         a commit
#   gp-build.sh main            a branch of gavofyork/graypaper
#   gp-build.sh pr/590          the head of a pull request
#   gp-build.sh pr/590-base     the commit that pull request branched from
#   gp-build.sh --resolve REF   print "<sha> <label>" without building
#   gp-build.sh --image         only build the TeX image (setup does this once)
#   gp-build.sh --text SHA      extract the text of a version built elsewhere (the public archive)
#
# Builds run in the TeX image from build-pdf.Dockerfile (built on first use).
set -euo pipefail

RESOLVE_ONLY= TEXT_ONLY=
if [ "${1:-}" = "--resolve" ]; then RESOLVE_ONLY=1; shift; fi
if [ "${1:-}" = "--text" ]; then TEXT_ONLY="${2:?usage: gp-build.sh --text SHA}"; set -- --image; fi
REF="${1:?usage: gp-build.sh [--resolve] <tag|sha|branch|pr/N|pr/N-base> | --image}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE="${GP_WORKSPACE:-$HERE/../workspace}"
GP="$ARCHIVE/graypaper"
DIST="$ARCHIVE/dist"

[ -d "$GP/.git" ] || git clone -q https://github.com/gavofyork/graypaper.git "$GP"
git -C "$GP" fetch -q origin '+refs/heads/*:refs/remotes/origin/*' --tags

case "$REF" in
  --image)
    SHA= LABEL=
    ;;
  pr/*-base)
    N="${REF#pr/}"; N="${N%-base}"
    git -C "$GP" fetch -q origin "+refs/pull/$N/head:refs/pr/$N"
    BASE_BRANCH="$(curl -fsS ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
      "https://api.github.com/repos/gavofyork/graypaper/pulls/$N" | jq -r .base.ref)"
    SHA="$(git -C "$GP" merge-base "refs/pr/$N" "origin/$BASE_BRANCH")"
    LABEL="PR #$N base"
    ;;
  pr/*)
    N="${REF#pr/}"
    git -C "$GP" fetch -q origin "+refs/pull/$N/head:refs/pr/$N"
    SHA="$(git -C "$GP" rev-parse "refs/pr/$N")"
    LABEL="PR #$N"
    ;;
  *)
    # A branch, a tag or commit, or a version without its "v" (0.8.1 for v0.8.1).
    SHA=
    for candidate in "origin/$REF" "$REF" "v$REF"; do
      SHA="$(git -C "$GP" rev-parse --verify -q "$candidate^{commit}")" && break
    done
    [ -n "$SHA" ] || { echo "unknown version: $REF (expected a tag like v0.8.1, a branch, a commit, pr/N or pr/N-base)" >&2; exit 1; }
    LABEL="$REF"
    ;;
esac

if [ -n "$RESOLVE_ONLY" ]; then
  echo "$SHA $LABEL"
  exit 0
fi

# One build at a time: builds share the TeX image, the graypaper checkout and the intermediate files.
# Everything that writes to the disk below happens under this lock.
mkdir -p "$DIST"
exec 9>"$ARCHIVE/.build.lock"
flock 9

# The image is tagged by its Dockerfile, so changing the Dockerfile builds a new one.
IMAGE="gp-compare-tex:$(sha256sum < "$HERE/build-pdf.Dockerfile" | cut -c1-12)"
IMAGE_FREE_GB=${IMAGE_FREE_GB:-10}   # a fresh image: the TeX packages take ~5 GB, and ~2 GB more while they unpack
BUILD_FREE_GB=${BUILD_FREE_GB:-2}    # one build is ~25 MB; keep room for logs and the OS

free_gb() { df --output=avail -BG "$DIST" | tail -1 | tr -dc 0-9; }

# Delete the least recently built versions (and cached public files) until enough space is free.
make_room() {
  while [ "$(free_gb)" -lt "$1" ]; do
    oldest="$( (ls -1tr "$DIST"/graypaper-*.pdf "$DIST"/.upstream-cache/graypaper-*.pdf 2>/dev/null || true) | head -1)"
    [ -n "$oldest" ] || { echo "only $(free_gb) GB free and nothing left to delete" >&2; exit 1; }
    sha="$(basename "$oldest" .pdf)"; sha="${sha#graypaper-}"
    dir="$(dirname "$oldest")"
    echo "low on disk: removing build $sha" >&2
    rm -rf "$dir/graypaper-$sha".* "$dir/tex-$sha"
  done
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  # Rebuilding on top of an existing image reuses its TeX layers and needs little space.
  if docker images -q gp-compare-tex | grep -q .; then make_room "$BUILD_FREE_GB"; else make_room "$IMAGE_FREE_GB"; fi
  DOCKER_BUILDKIT=1 timeout 60m docker build -t "$IMAGE" -f "$HERE/build-pdf.Dockerfile" "$HERE" ||
    { docker builder prune -af >/dev/null 2>&1; exit 1; }
  docker images gp-compare-tex --format '{{.Repository}}:{{.Tag}}' | grep -vx "$IMAGE" | xargs -r docker rmi >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1  # the package downloads are not needed after the image exists
fi
RUN=(docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$HERE:/app/server:ro,z" -v "$HERE/../src:/app/src:ro,z" -v "$HERE/../package.json:/app/package.json:ro,z"
  -v "$GP:/workspace/graypaper:z" -v "$DIST:/workspace/dist:z")

if [ -n "$TEXT_ONLY" ]; then
  [ -f "$DIST/graypaper-$TEXT_ONLY.text.json" ] && exit 0
  pdf="graypaper-$TEXT_ONLY.pdf"
  [ -f "$DIST/$pdf" ] || pdf=".upstream-cache/$pdf"
  [ -f "$DIST/$pdf" ] || curl -fsS --create-dirs -o "$DIST/$pdf" "https://gp.fluffylabs.dev/graypaper-$TEXT_ONLY.pdf"
  exec timeout 5m "${RUN[@]}" -e VERSION="$TEXT_ONLY" -e TEXT_FROM="/workspace/dist/$pdf" "$IMAGE"
fi
[ "$REF" = "--image" ] && exit 0

if [ ! -f "$DIST/graypaper-$SHA.pdf" ]; then
  make_room "$BUILD_FREE_GB"
  git -C "$GP" -c advice.detachedHead=false checkout -q --detach "$SHA"
  timeout 10m "${RUN[@]}" -e VERSION="$SHA" "$IMAGE" ||
    { rm -f "$DIST"/graypaper.* "$DIST/graypaper-$SHA".*; rm -rf "$DIST/tex-$SHA"; exit 1; }
fi

echo "$SHA $LABEL"
