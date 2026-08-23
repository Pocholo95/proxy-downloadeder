import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Radix-style className combiner: merges clsx + tailwind-merge. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Yields to the browser for two animation frames so React can commit the
 * current state update and any DOM observers (e.g. auto-animate) can
 * detect the mutation before the next synchronous state change.
 */
export const yieldToBrowser = () =>
  new Promise<void>((res) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => res());
    });
  });
