import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useSectionSync } from "@/hooks/useSectionSync";

interface SectionProps {
  label?: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  bodyClassName?: string;
  renderTrigger?: (expanded: boolean) => React.ReactNode;
  className?: string;
  /**
   * Group identifier for Shift+click sync.
   * When Shift is held, all sections with the same groupKey will be set to
   * the same expanded state via a CustomEvent.
   */
  groupKey?: string;
}

/**
 * A collapsible fieldset-style section used inside the ControlPanel.
 */
export default function Section({
  label,
  expanded,
  onToggle,
  children,
  bodyClassName,
  renderTrigger,
  className,
  groupKey,
}: SectionProps) {
  const { handleOpenChange, shiftRef } = useSectionSync(
    groupKey,
    expanded,
    onToggle,
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    shiftRef.current = e.shiftKey;
    if (e.shiftKey) {
      e.preventDefault();
    }
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={handleOpenChange}
      data-group={groupKey}
    >
      <div
        className={cn("rounded-lg border shadow-sm", className)}
        onPointerDown={handlePointerDown}
      >
        <CollapsibleTrigger asChild>
          {renderTrigger ? (
            <div
              role="button"
              tabIndex={0}
              className={cn(
                "bg-muted/50 hover:bg-muted flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-sm font-bold transition-colors",
                expanded ? "rounded-t-lg" : "rounded-lg",
              )}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  shiftRef.current = e.shiftKey;
                }
              }}
            >
              {renderTrigger(expanded)}
            </div>
          ) : (
            <button
              type="button"
              aria-expanded={expanded}
              className={cn(
                "bg-muted/50 hover:bg-muted flex w-full items-center justify-between px-4 py-3 text-sm font-bold transition-colors",
                expanded ? "rounded-t-lg" : "rounded-lg",
              )}
            >
              <span>{label}</span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 transition-transform duration-200",
                  expanded && "rotate-180",
                )}
              />
            </button>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            className={cn(
              "grid grid-cols-1 gap-4 gap-x-12 border-t p-4 sm:grid-cols-2",
              bodyClassName,
            )}
          >
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
