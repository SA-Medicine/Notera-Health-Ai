'use strict';
// A speech request that hangs (3 of 17 live chunks on 2026-11-04 took 58-63 s instead of 2 s) used to hold the whole chain for the engine timeout (60 s),
// while the app gave up on the chunk after 30 s and fell back to re-sending the whole recording (+36 s on a 22-minute visit).
// The fix keeps the SAME engine (same quality): if no answer arrives in `hedgeMs`, or the first request fails, the identical request is sent once more and
// the first good answer wins. Cost: a second request only in the slow tail (about $0.002 a minute of audio).

/** Time after which a second identical request is sent: 5x the normal answer time, never under 10 s (20 s chunk: 11 s, 120 s window: 36 s). */
export function hedgeAfterMs(audioSeconds) { return Math.max(10000, Math.round(Number(audioSeconds || 0) * 250) + 6000); }

/**
 * @param {(signal: AbortSignal) => Promise<any>} makeRequest  one attempt; must honour the abort signal
 * @param {{hedgeMs?: number, timeoutMs?: number, onHedge?: (why: string) => void}} o
 * Resolves with the first success. Rejects only when two attempts have both failed (or the single attempt failed and hedging is off).
 */
export function hedgedRequest(makeRequest, { hedgeMs = 11000, timeoutMs = 80000, onHedge = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const ctls = []; const timers = []; let settled = false; let launched = 0; let failed = 0; let hedgeTimer = null;
    const finish = (fn, v) => {
      if (settled) return; settled = true; clearTimeout(hedgeTimer); timers.forEach(clearTimeout);
      for (const c of ctls) { try { c.abort(); } catch { /* already finished */ } }
      fn(v);
    };
    const launch = (why) => {
      launched++; const ctl = new AbortController(); ctls.push(ctl);
      timers.push(setTimeout(() => { try { ctl.abort(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`)); } catch { /* ignore */ } }, timeoutMs));
      if (why) onHedge(why);
      Promise.resolve().then(() => makeRequest(ctl.signal)).then(
        (v) => finish(resolve, v),
        (e) => {
          if (settled) return; failed++;
          if (launched < 2 && hedgeMs > 0) { clearTimeout(hedgeTimer); launch('first request failed: ' + String(e && e.message || e).slice(0, 80)); return; }
          if (failed >= launched) finish(reject, e);
        });
    };
    launch();
    if (hedgeMs > 0) hedgeTimer = setTimeout(() => { if (!settled && launched < 2) launch(`no answer in ${Math.round(hedgeMs / 1000)}s`); }, hedgeMs);
  });
}
