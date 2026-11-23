/** "1h 02m 05s": time left shown in hours, minutes and seconds. */
export function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Time left from the bytes still to go and the recent speed. The speed is smoothed so the number does not jump when the link speeds up and slows down;
 * while the speed reads zero (a pause, or Wi-Fi dropped) the last estimate is kept rather than showing an endless time.
 */
export function createEtaEstimator(alpha = 0.15) {
  let speed = 0;
  return {
    update(done: number, total: number, bytesPerSecond?: number): string | null {
      if (total <= 0 || done >= total) { speed = 0; return null; }
      if (bytesPerSecond && bytesPerSecond > 0) speed = speed === 0 ? bytesPerSecond : (1 - alpha) * speed + alpha * bytesPerSecond;
      return speed > 0 ? formatEta((total - done) / speed) : null;
    },
    reset() { speed = 0; },
  };
}
