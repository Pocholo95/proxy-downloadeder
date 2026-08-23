import { type ComponentProps } from "react";
import { cn } from "@/lib/utils";

type KbdProps = ComponentProps<"kbd">;

/**
 * Keyboard key primitive for displaying keyboard shortcuts.
 * Styled to remain visible across all button variants and themes.
 */
function Kbd({ className, ...props }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm",
        "border border-border bg-muted/50 px-1 font-mono text-xs text-foreground/85 select-none",
        "in-data-[slot=tooltip-content]:border-transparent in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background",
        "dark:in-data-[slot=tooltip-content]:bg-background/10",
        "[&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
