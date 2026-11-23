#!/usr/bin/env python3
"""gp-compare backend.

  /archive/<file>     builds in the public archive layout: graypaper-<sha>.pdf,
                      graypaper-<sha>.synctex.json, tex-<sha>/... Local builds first,
                      then the public archive (cached on disk).
  /api/version?ref=   resolve a ref (tag, branch, sha, pr/N, pr/N-base) to a commit and
                      start building it if no archive has it. Poll until state is "ready".
  /api/refs           tags and open pull requests, for the ref pickers.
  /                   the built web app (../dist), when present.

    python3 server/server.py          # http://localhost:8787 (HOST and PORT to change)
    python3 server/server.py --warm   # build the head and base of every open PR not built yet

GITHUB_TOKEN, if set, raises the GitHub API rate limit; it needs no scopes.
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
UPSTREAM = "https://gp.fluffylabs.dev"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
REPO = "gavofyork/graypaper"
ARCHIVE = Path(os.environ.get("GP_WORKSPACE", HERE / "../workspace")).resolve()
DIST = ARCHIVE / "dist"
CACHE = DIST / ".upstream-cache"
WEB = (HERE / "../dist").resolve()
BUILD = HERE / "gp-build.sh"
HEADERS = {"User-Agent": "gp-compare/1.0"}

builds = {}  # sha -> {"state": "building" | "error", "log": str}
cached = {}  # key -> (time, value)


def remember(key, ttl, compute):
    hit = cached.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = compute()
    cached[key] = (time.time(), value)
    return value


def upstream_versions():
    def fetch_metadata():
        request = urllib.request.Request(UPSTREAM + "/metadata.json", headers=HEADERS)
        return set(json.loads(urllib.request.urlopen(request, timeout=20).read())["versions"])

    return remember("upstream", 600, fetch_metadata)


def resolve(ref):
    out = subprocess.run([BUILD, "--resolve", ref], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise ValueError(out.stderr.strip().splitlines()[-1] if out.stderr.strip() else f"cannot resolve {ref}")
    sha, label = out.stdout.strip().split(" ", 1)
    return sha, label


def has_local(sha):
    return (DIST / f"graypaper-{sha}.pdf").is_file() and (DIST / f"graypaper-{sha}.synctex.json").is_file()


def start_build(ref, sha):
    builds[sha] = {"state": "building", "log": ""}

    def run():
        out = subprocess.run([BUILD, ref], capture_output=True, text=True)
        if out.returncode == 0 and has_local(sha):
            builds.pop(sha, None)
        else:
            builds[sha] = {"state": "error", "log": (out.stdout + out.stderr)[-3000:]}

    threading.Thread(target=run, daemon=True).start()


def version_status(ref):
    sha, label = resolve(ref)
    status = {"ref": ref, "sha": sha, "label": label}
    if has_local(sha) or sha in upstream_versions():
        return {**status, "state": "ready"}
    build = builds.get(sha)
    if build is None:
        start_build(ref, sha)
        build = builds[sha]
    elif build["state"] == "error":
        builds.pop(sha)  # report the failure once; asking again retries the build
    return {**status, **build}


def github(path):
    headers = {**HEADERS, "Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    request = urllib.request.Request(f"https://api.github.com/repos/{REPO}/{path}", headers=headers)
    return json.loads(urllib.request.urlopen(request, timeout=20).read())


def open_pulls():
    return github("pulls?state=open&per_page=100")


def list_refs():
    gp = ARCHIVE / "graypaper"
    tags = subprocess.run(
        ["git", "-C", gp, "tag", "-l", "v*", "--sort=-creatordate"], capture_output=True, text=True
    ).stdout.split()
    pulls = [{"number": p["number"], "title": p["title"], "author": p["user"]["login"]} for p in open_pulls()]
    return {"tags": tags, "branches": ["main"], "pulls": pulls}


def warm():
    """Build what open PRs need. Cheap when nothing changed: one API call, no git, no builds."""
    for pull in open_pulls():
        if has_local(pull["head"]["sha"]):
            continue
        for ref in (f"pr/{pull['number']}", f"pr/{pull['number']}-base"):
            out = subprocess.run([BUILD, ref], capture_output=True, text=True)
            print(ref, "ok" if out.returncode == 0 else f"failed: {(out.stdout + out.stderr)[-500:]}", file=sys.stderr)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass

    def send_json(self, value, code=200):
        body = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if ".." in Path(url.path).parts:
            return self.send_error(400)
        try:
            if url.path == "/api/version":
                ref = parse_qs(url.query).get("ref", [""])[0].strip()
                return self.send_json(version_status(ref)) if ref else self.send_json({"error": "ref missing"}, 400)
            if url.path == "/api/refs":
                return self.send_json(remember("refs", 300, list_refs))
        except Exception as e:  # noqa: BLE001 - report any failure to the page
            return self.send_json({"state": "error", "log": str(e)}, 400)
        if url.path.startswith("/archive/"):
            return self.send_archive_file(url.path.removeprefix("/archive/"))
        return super().do_GET()

    def send_archive_file(self, name):
        path = DIST / name
        if not path.is_file():
            path = CACHE / name
            if not path.is_file():
                try:
                    fetch(f"{UPSTREAM}/{name}", path)
                except Exception as e:  # noqa: BLE001
                    return self.send_error(404, str(e))
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Cache-Control", "max-age=31536000, immutable")
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)


def fetch(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as response:
        with open(tmp, "wb") as out:
            shutil.copyfileobj(response, out)
    tmp.rename(dest)


if __name__ == "__main__":
    DIST.mkdir(parents=True, exist_ok=True)
    if sys.argv[1:] == ["--warm"]:
        warm()
    else:
        print(f"gp-compare server on http://{HOST}:{PORT} (archive {DIST})", file=sys.stderr)
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
