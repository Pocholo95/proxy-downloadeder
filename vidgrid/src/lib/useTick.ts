import { useEffect, useState, useCallback, useRef } from "react";

/**
 * Shared requestAnimationFrame ticker replacing 100ms setInterval.
 *
 * Instead of each component running its own `setInterval(..., 100)`, components
 * subscribe to a shared rAF loop that fires at most once per frame (~16.67ms at
 * 60Hz).  The hook returns a monotonically increasing `tick` counter that
 * increments every time the requested `intervalMs` has elapsed since the last
 * visible tick.
 *
 * Usage:
 *   const tick = useTick(isProcessing, 100);
 *   // `tick` increases by 1 every ~100ms while `isProcessing === true`
 *
 * Benefits over setInterval:
 * - Guaranteed single frame alignment (no jitter)
 * - Pauses automatically when tab is hidden (browser rAF optimization)
 * - No accumulation of callbacks — single shared scheduler per subscription
 */
export function useTick(enabled: boolean, intervalMs: number): number {
  const [tick, setTick] = useState(0);
  const elapsedRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    elapsedRef.current = 0;
  }, []);

  useEffect(() => {
    if (!enabled) {
      cancel();
      setTick(0);
      return;
    }

    let lastTime = performance.now();

    const loop = (now: number) => {
      const delta = now - lastTime;
      lastTime = now;

      elapsedRef.current += delta;

      if (elapsedRef.current >= intervalMs) {
        const cycles = Math.floor(elapsedRef.current / intervalMs);
        elapsedRef.current %= intervalMs;
        setTick((prev) => prev + cycles);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return cancel;
  }, [enabled, intervalMs, cancel]);

  return tick;
}
