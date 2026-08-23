import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * Container for related fields. Stacks them vertically with consistent spacing,
 * suitable for forms / settings sections.
 */
function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-4",
        className,
      )}
      {...props}
    />
  );
}

const fieldVariants = cva(
  "group/field flex w-full gap-2 data-[invalid=true]:text-destructive",
  {
    variants: {
      orientation: {
        vertical: "flex-col [&>[data-slot=field-label]]:font-medium",
        horizontal:
          "flex-row items-center [&>[data-slot=field-label]]:flex-auto [&>[data-slot=field-content]]:flex-auto",
        responsive:
          "flex-col [&>[data-slot=field-label]]:font-medium @md/field-group:flex-row @md/field-group:items-center",
      },
    },
    defaultVariants: {
      orientation: "vertical",
    },
  },
);

/**
 * A single form/settings field. Composes a `FieldLabel`, a control (e.g.
 * `Input`, `Select`, `Checkbox`), and an optional `FieldDescription` /
 * `FieldError`.
 *
 * - `vertical` (default): label above the control. Best for typed inputs.
 * - `horizontal`: label inline with the control. Best for `Checkbox` /
 *   `Switch` rows where the control comes first.
 */
function Field({
  className,
  orientation,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation ?? "vertical"}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

/**
 * Label for a Field. Wraps Radix's Label primitive (which itself wraps
 * Radix Label) and adds field-level styling tweaks (peer-disabled color,
 * cursor-pointer for clickable rows).
 */
function FieldLabel({
  className,
  ...props
}: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        "flex w-fit items-center gap-2 leading-snug",
        "group-data-[orientation=horizontal]/field:cursor-pointer",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Wrapper that holds the label + (optional) description as a stack when used
 * inside a horizontal Field — useful for `Checkbox` rows where the description
 * belongs under the label, not under the control.
 */
function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn("flex flex-col gap-1 leading-snug", className)}
      {...props}
    />
  );
}

/**
 * Helper text rendered below the control. Pass an `id` and wire it up via
 * `aria-describedby` on the control for full a11y.
 */
function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        "text-muted-foreground text-xs leading-snug",
        "group-data-[invalid=true]/field:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Inline error message rendered below the control. Setting this implicitly
 * marks the parent Field as invalid (consumers should also set
 * `data-invalid="true"` on the parent Field for full styling).
 */
function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn("text-destructive text-xs leading-snug", className)}
      {...props}
    />
  );
}

/**
 * Fieldset wrapper for related groups of fields with an optional legend.
 * Renders as a real <fieldset> for native form semantics.
 */
function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        "flex flex-col gap-3 rounded-md border p-3",
        "[&>legend]:px-1 [&>legend]:text-sm [&>legend]:font-medium",
        className,
      )}
      {...props}
    />
  );
}

function FieldLegend({
  className,
  asChild,
  ...props
}: React.ComponentProps<"legend"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "legend";
  return (
    <Comp
      data-slot="field-legend"
      className={cn("text-foreground", className)}
      {...props}
    />
  );
}

function FieldSeparator({ className, ...props }: React.ComponentProps<"hr">) {
  return (
    <hr
      data-slot="field-separator"
      className={cn("shrink-0 bg-border", className)}
      {...props}
    />
  );
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldSeparator,
};
