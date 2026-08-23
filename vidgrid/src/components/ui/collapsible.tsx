import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cn } from "@/lib/utils";

const OpenContext = React.createContext<boolean>(false);

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return (
    <CollapsiblePrimitive.Root data-slot="collapsible" {...props}>
      <OpenContext.Provider value={props.open ?? false}>
        {props.children}
      </OpenContext.Provider>
    </CollapsiblePrimitive.Root>
  );
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  const open = React.useContext(OpenContext);

  // Use asChild to merge Radix props onto a transparent span,
  // then our wrapper div is NOT affected by Radix's inline height styles.
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      forceMount
      asChild
      {...props}
    >
      <span style={{ display: "contents" }}>
        <div
          className={cn(
            "grid grid-cols-1 overflow-hidden",
            "transition-[grid-template-rows] duration-250 ease-out",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            className,
          )}
        >
          <div className="min-h-0">{children}</div>
        </div>
      </span>
    </CollapsiblePrimitive.CollapsibleContent>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
