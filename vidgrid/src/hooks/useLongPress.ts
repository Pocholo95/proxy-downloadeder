import { useCallback, useRef } from "react";

export interface UseLongPressOptions {
  thresholdMs?: number; // how long to hold to trigger (default: 600)
}

/**
 * Hook that fires a callback when the user holds down on an element
 * for at least `thresholdMs` ms (without dragging away).
 *
 * Returns handler props so you can spread them on any element:
 *
 *   <div {...useLongPress(() => console.log("long press!"))} />
 */
export function useLongPress(
  onLongPress: () => void,
  opts: UseLongPressOptions = {},
) {
  const { thresholdMs = 600 } = opts;
  const timerRef = useRef<number | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();

      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        onLongPress();
      }, thresholdMs);
    },
    [onLongPress, thresholdMs],
  );

  const onPointerUp = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerLeave = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerCancel = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return {
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
  };
}
