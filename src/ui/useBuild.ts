import { useEffect, useState } from "react";

export interface BuildStatus {
  state: "resolving" | "building" | "ready" | "error";
  ref: string;
  sha?: string;
  label?: string;
  log?: string;
}

const POLL_MS = 2000;

/** Resolve a ref to a commit and wait until a build of it is available. */
export function useBuild(ref: string): BuildStatus | null {
  const [status, setStatus] = useState<BuildStatus | null>(null);

  useEffect(() => {
    if (!ref) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    setStatus({ state: "resolving", ref });

    const poll = async () => {
      try {
        const response = await fetch(`/api/version?ref=${encodeURIComponent(ref)}`);
        const body = (await response.json()) as BuildStatus;
        if (cancelled) return;
        setStatus({ ...body, ref, state: body.state ?? "error" });
        if (body.state === "building") timer = window.setTimeout(poll, POLL_MS);
      } catch (e) {
        if (!cancelled) setStatus({ state: "error", ref, log: String(e) });
      }
    };
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ref]);

  return status;
}
