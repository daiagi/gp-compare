/** URLs of a build in the archive layout (graypaper-<sha>.pdf, .synctex.json, tex-<sha>/). `base` is the archive root. */
export function archiveUrls(base: string, sha: string) {
  return {
    pdf: `${base}/graypaper-${sha}.pdf`,
    synctex: `${base}/graypaper-${sha}.synctex.json`,
    tex: (path: string) => `${base}/tex-${sha}/${path}`,
  };
}
