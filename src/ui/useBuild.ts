import { useEffect, useState } from "react";

export interface BuildStatus {
  state: "resolving" | "building" | "ready" | "error";
  ref: string;
  sha?: string;
  label?: string;
  log?: string;
}

const POLL_MS = 2000;
const MAX_FAILURES = 15;

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

    let failures = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/version?ref=${encodeURIComponent(ref)}`);
        const body = (await response.json()) as BuildStatus;
        if (cancelled) return;
        setStatus({ ...body, ref, state: body.state ?? "error" });
        if (body.state === "building") timer = window.setTimeout(poll, POLL_MS);
      } catch (e) {
        // The server restarting or busy (an empty 502 from the proxy) is not a failed build: keep trying.
        if (cancelled) return;
        if (++failures < MAX_FAILURES) timer = window.setTimeout(poll, POLL_MS);
        else setStatus({ state: "error", ref, log: String(e) });
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
