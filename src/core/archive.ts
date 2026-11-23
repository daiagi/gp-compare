/** URLs of a build in the archive layout (graypaper-<sha>.pdf, .synctex.json, tex-<sha>/). `base` is the archive root. */
export function archiveUrls(base: string, sha: string) {
  return {
    pdf: `${base}/graypaper-${sha}.pdf`,
    synctex: `${base}/graypaper-${sha}.synctex.json`,
    /** The PDF's text runs per page, extracted on the server (server/extract-text.mts); may not exist yet. */
    text: `${base}/graypaper-${sha}.text.json`,
    tex: (path: string) => `${base}/tex-${sha}/${path}`,
  };
}
