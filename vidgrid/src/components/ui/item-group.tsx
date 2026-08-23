import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Container for related items. Stacks them vertically with consistent spacing,
 * suitable for selectable lists / menus.
 */
function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-group"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
}

const itemVariants = cva(
  "group/item relative flex rounded-md border p-0 shadow-sm focus:ring-1 focus-within:ring-ring",
  {
    variants: {
      disabled: {
        true: "pointer-events-none opacity-50",
      },
    },
    defaultVariants: {
      disabled: false,
    },
  },
);

/**
 * A single selectable item within an ItemGroup. Supports composition via `asChild`.
 */
function Item({
  className,
  disabled,
  asChild,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof itemVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-slot="item"
      data-disabled={disabled || undefined}
      className={cn(
        itemVariants({ disabled }),
        "data-[disabled=true]:cursor-not-allowed",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Optional description/helper text for an Item.
 */
function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        "text-muted-foreground text-xs leading-snug group-data-[disabled=true]/item:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { ItemGroup, Item, ItemDescription };
