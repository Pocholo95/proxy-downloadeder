import * as React from "react";

/**
 * Hover-arm hook: only "arms" after the cursor has rested on the element for
 * the requested delay.
 *
 * This is useful for controls that respond to wheel events — it prevents
 * inadvertent value changes while the user is scrolling through the page,
 * while still allowing quick adjustments once the cursor is intentionally
 * placed on the control.
 *
 * @param delayMs  How long the mouse must rest on the element before it arms
 *                 (default 250 ms).
 * @returns A tuple `[ref, isArmed]` where `ref` should be attached to the
 *          target element and `isArmed` is a ref whose `.current` reads
 *          `true` while the control is armed.  Using a ref (not state) for
 *          `isArmed` avoids unnecessary re-renders on every wheel event.
 *
 * @example
 * ```tsx
 * const [elRef, isArmed] = useHoverArm(250);
 * // In your wheel handler:
 *   if (isArmed.current) { e.preventDefault(); adjustValue(); }
 * ```
 */
export function useHoverArm(
  delayMs = 250,
): [React.RefObject<HTMLElement | null>, React.MutableRefObject<boolean>] {
  const elRef = React.useRef<HTMLElement | null>(null);
  const isArmed = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const enter = () => {
      isArmed.current = false;
      timerRef.current = setTimeout(() => {
        isArmed.current = true;
      }, delayMs);
    };

    const leave = () => {
      isArmed.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);

    return () => {
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [delayMs]);

  return [elRef, isArmed];
}
