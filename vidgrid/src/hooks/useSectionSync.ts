import { useCallback, useEffect, useRef } from "react";

/**
 * Hook that handles Shift+click sync for collapsible sections.
 *
 * - When Shift is held during toggle, dispatches a CustomEvent to sync
 *   all sibling sections with the same groupKey to the target state.
 * - Listens for those events and calls onToggle when a sibling triggers sync.
 *
 * @param groupKey - Group identifier; sections sharing a key sync together.
 * @param expanded - Current expanded state of this section.
 * @param onToggle - Callback to flip this section's state.
 */
export function useSectionSync(
  groupKey: string | undefined,
  expanded: boolean,
  onToggle: () => void,
) {
  const shiftRef = useRef(false);

  const handleOpenChange = useCallback(() => {
    const target = !expanded;

    if (groupKey && shiftRef.current) {
      window.dispatchEvent(
        new CustomEvent("section-sync", {
          detail: { group: groupKey, expanded: target },
        }),
      );
    } else {
      onToggle();
    }

    shiftRef.current = false;
  }, [groupKey, expanded, onToggle]);

  // Listen for sync events from sibling sections in the same group.
  // Only toggle if our current state differs from the target.
  useEffect(() => {
    if (!groupKey) return;

    const handler = (e: Event) => {
      const { group, expanded: target } = (e as CustomEvent).detail as {
        group: string;
        expanded: boolean;
      };
      if (group === groupKey && target !== expanded) {
        onToggle();
      }
    };

    window.addEventListener("section-sync", handler);
    return () => window.removeEventListener("section-sync", handler);
  }, [groupKey, expanded, onToggle]);

  return { handleOpenChange, shiftRef };
}
