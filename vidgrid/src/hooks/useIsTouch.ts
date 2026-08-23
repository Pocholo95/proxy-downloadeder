import { useEffect, useState } from "react";

/**
 * Synchronously detects whether the device is touch-oriented using a
 * multi-signal heuristic.
 *
 * Samsung Internet on Android is a notorious edge case: it reports
 * `(any-pointer: fine)` and `(hover: hover)` (mimicking a desktop UA), and
 * may also report `navigator.maxTouchPoints === 0`.  To reliably detect it
 * as a touch device we check multiple signals — if *any* of these fire we
 * treat the device as touch-oriented:
 *
 * 1. `(any-pointer: coarse)` media query matches
 * 2. `(hover: hover) and (any-pointer: fine)` does NOT match
 * 3. `navigator.maxTouchPoints > 0`
 * 4. `window.ontouchstart` is defined (legacy but still reliable on
 *    Samsung Internet)
 * 5. User-Agent contains mobile identifier (Android, iPhone, etc.)
 *
 * This approach is intentionally permissive: it's better to show touch
 * hints on a rare hybrid desktop than to break the UI on a touch phone.
 */
function detectTouch() {
  return (
    window.matchMedia("(any-pointer: coarse)").matches ||
    !window.matchMedia("(hover: hover) and (any-pointer: fine)").matches ||
    navigator.maxTouchPoints > 0 ||
    "ontouchstart" in window ||
    /Android|iPhone|iPad|iPod/.test(navigator.userAgent)
  );
}

/**
 * React hook that detects whether the current device is touch-oriented.
 *
 * Returns a stable boolean that is correct on the first render (no flash of
 * wrong UI) and updates when the underlying media queries change.
 */
export function useIsTouch() {
  const [isTouch, setIsTouch] = useState(detectTouch);

  useEffect(() => {
    const coarseQuery = window.matchMedia("(any-pointer: coarse)");
    const fineQuery = window.matchMedia(
      "(hover: hover) and (any-pointer: fine)",
    );

    const update = () => setIsTouch(detectTouch());

    coarseQuery.addEventListener("change", update);
    fineQuery.addEventListener("change", update);

    return () => {
      coarseQuery.removeEventListener("change", update);
      fineQuery.removeEventListener("change", update);
    };
  }, []);

  return isTouch;
}
