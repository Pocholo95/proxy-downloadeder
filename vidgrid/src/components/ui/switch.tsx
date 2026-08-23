import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { CheckIcon, XIcon } from "lucide-react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

function Switch({
  className,
  label,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  label?: string;
}) {
  const id = props.id ?? `switch-${React.useId()}`;

  const switchContent = (
    // Separate relative container so absolute icons don't escape the track
    <div className="relative inline-flex items-center">
      <SwitchPrimitive.Root
        id={id}
        data-slot="switch"
        className={cn(
          "peer group/switch inline-flex h-6 w-10.5 shrink-0 items-center",
          "transition-[color,background-color] duration-200 ease-in-out",
          "rounded-full bg-input/40",
          "data-[state=checked]:bg-primary",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2",
          "disabled:pointer-events-none disabled:opacity-50",
          "[&_span]:bg-background!",
          "[&_span]:h-4 [&_span]:w-4 [&_span]:rounded-full",
          "[&_span]:transition-transform [&_span]:duration-200 [&_span]:ease-in-out",
          "[&_span]:data-[state=checked]:translate-x-5.5",
          "[&_span]:data-[state=unchecked]:translate-x-1",
          className,
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb />
      </SwitchPrimitive.Root>
      {/* Check icon — visible when checked */}
      <span
        className={cn(
          "pointer-events-none absolute left-1",
          "text-primary-foreground",
          "transition-transform duration-200 ease-in-out",
          "peer-data-[state=unchecked]:invisible peer-data-[state=unchecked]:translate-x-full",
        )}
      >
        <CheckIcon className="size-3.5" aria-hidden="true" />
      </span>
      {/* X icon — visible when unchecked */}
      <span
        className={cn(
          "pointer-events-none absolute right-1",
          "text-muted-foreground",
          "transition-transform duration-200 ease-in-out",
          "peer-data-[state=checked]:invisible peer-data-[state=checked]:-translate-x-full",
        )}
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </span>
    </div>
  );

  // When a label is provided, wrap in Radix Label (already flex items-center gap-2)
  if (label) {
    return (
      <Label htmlFor={id}>
        {switchContent}
        <span className="inline-flex items-center">{label}</span>
      </Label>
    );
  }

  return switchContent;
}

export { Switch };
