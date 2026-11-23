# gp-compare

Compare any two Gray Paper versions side by side, rendered, with the changes highlighted:
removed in red on the left, added in green on the right. Live at **https://gpdiff.dev**.

```
https://gpdiff.dev/?left=v0.7.2&right=v0.8.0
https://gpdiff.dev/?pr=590                      # a PR against the commit it branched from
https://gpdiff.dev/?left=main&right=8c305b5
https://gpdiff.dev/?pr=590&change=3             # open at a given change
```

A version is a tag, a branch, a commit, `pr/N` or `pr/N-base`. Releases load at once; anything
else is built on first use (about 30 seconds) and cached.

- Both sides scroll together on the same content; Shift + wheel scrolls one side alone.
- `]` / `n` and `[` / `p` jump between changes; the URL follows, so it can be shared.
- The Source panel shows the TeX lines behind the current change.

## What counts as a change

Only what reads differently on the page, where the TeX source changed too. Not marked: reflowed
text, line breaks and hyphenation, punctuation on its own, renumbered equations and references,
and source edits that render the same. `N` → `N₁` marks only the `1`.

## Run it yourself

```sh
npm install
npm run server     # API and builds on :8787 (needs Docker, git, jq, curl)
npm run dev        # app on :5174
```

`src/core` holds the comparison without any UI. It needs only each version's PDF text, synctex
JSON and TeX sources, so another Gray Paper viewer can reuse it.
