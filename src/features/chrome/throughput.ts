import { useEffect, useState } from "react";
import { workspaceThroughput } from "../../lib/ipc";
import { strings } from "../../lib/strings";

const s = strings.statusPill;

/** How often the pill asks for the rate (the backend measures over a 2 s window). */
export const THROUGHPUT_POLL_MS = 1000;

/**
 * `0 B/s`, `999 B/s`, `1.2 KB/s`, `12 KB/s`, `3.4 MB/s`: whole bytes, then one decimal
 * below 10 of a unit and whole numbers above (1 KB = 1000 B). A value that rounds to 1000
 * moves to the next unit, so the text stays within 8 characters up to 999 GB/s.
 */
export function formatRate(bytesPerSec: number): string {
  let value = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec : 0;
  const units = s.rateUnits;
  for (let i = 0; ; i++) {
    const last = i === units.length - 1;
    const text = i === 0 || value >= 9.95 ? String(Math.round(value)) : value.toFixed(1);
    if (last || Number(text) < 1000) return s.rate(text, units[i]);
    value /= 1000;
  }
}

/**
 * The live network rate of workspace `workspaceId` (bytes/s, read + written) while
 * `enabled`, asked from the backend at once and then every second (#112). Paused while the
 * window is hidden (minimized): no call and no number then; shown again, it starts over
 * blank. Null until the backend has a rate, when it has none to give, or when the call
 * fails: never a guess.
 */
export function useThroughput(workspaceId: string, enabled: boolean): number | null {
  const [rate, setRate] = useState<{ workspaceId: string; value: number | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    // Bumped by every stop: an answer to an older run is dropped.
    let run = 0;
    const poll = async (mine: number) => {
      let value: number | null = null;
      try {
        const r = await workspaceThroughput(workspaceId);
        value = r ? r.readPerSec + r.writtenPerSec : null;
      } catch {
        value = null;
      }
      if (mine === run) setRate({ workspaceId, value });
    };
    const start = () => {
      if (timer !== null) return;
      const mine = run;
      void poll(mine);
      timer = setInterval(() => void poll(mine), THROUGHPUT_POLL_MS);
    };
    const stop = () => {
      run += 1;
      if (timer !== null) clearInterval(timer);
      timer = null;
      // A later start shows nothing until it has its own answer.
      setRate(null);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [workspaceId, enabled]);
  // Only this workspace's own answer, and only while asked for.
  return enabled && rate?.workspaceId === workspaceId ? rate.value : null;
}
