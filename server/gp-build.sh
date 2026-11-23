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
#
# Builds run in the TeX image from build-pdf.Dockerfile (built on first use).
set -euo pipefail

RESOLVE_ONLY=
if [ "${1:-}" = "--resolve" ]; then RESOLVE_ONLY=1; shift; fi
REF="${1:?usage: gp-build.sh [--resolve] <tag|sha|branch|pr/N|pr/N-base>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE="${GP_WORKSPACE:-$HERE/../workspace}"
GP="$ARCHIVE/graypaper"
DIST="$ARCHIVE/dist"

IMAGE=gp-compare-tex
docker image inspect "$IMAGE" >/dev/null 2>&1 ||
  docker build -t "$IMAGE" -f "$HERE/build-pdf.Dockerfile" "$HERE"

[ -d "$GP/.git" ] || git clone -q https://github.com/gavofyork/graypaper.git "$GP"
git -C "$GP" fetch -q origin '+refs/heads/*:refs/remotes/origin/*' --tags

case "$REF" in
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
    SHA="$(git -C "$GP" rev-parse --verify -q "origin/$REF^{commit}" || git -C "$GP" rev-parse --verify "$REF^{commit}")"
    LABEL="$REF"
    ;;
esac

if [ -n "$RESOLVE_ONLY" ]; then
  echo "$SHA $LABEL"
  exit 0
fi

mkdir -p "$DIST"

# One build at a time: builds share the graypaper checkout and the intermediate files.
exec 9>"$ARCHIVE/.build.lock"
flock 9
if [ ! -f "$DIST/graypaper-$SHA.pdf" ]; then
  git -C "$GP" -c advice.detachedHead=false checkout -q --detach "$SHA"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e VERSION="$SHA" \
    -v "$GP:/workspace/graypaper:z" -v "$DIST:/workspace/dist:z" "$IMAGE"
fi

echo "$SHA $LABEL"
