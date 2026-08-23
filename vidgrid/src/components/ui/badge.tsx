import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import {
  Clock,
  CheckCircle,
  AlertCircle,
  XCircle,
  Loader2,
} from "lucide-react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2.5 py-1 text-xs font-medium w-fit whitespace-nowrap shrink-0 gap-1.5 [&>svg]:size-3.5 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-all duration-300 overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-transparent bg-destructive/20 text-destructive [a&]:hover:bg-destructive/30",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        // Status variants with animation support
        queued:
          "border-transparent bg-muted/80 text-muted-foreground/80 backdrop-blur-sm hover:bg-muted/90",
        processing:
          "border-transparent bg-primary/20 text-primary animate-pulse",
        done: "border-transparent bg-emerald-500/20 text-emerald-500 border-emerald-400/30",
        success:
          "border-transparent bg-emerald-500/20 text-emerald-400 border-emerald-400/30",
        error:
          "border-transparent bg-destructive/20 text-destructive-foreground border-destructive/30 animate-pulse",
        cancelled:
          "border-transparent bg-muted/100 text-muted-foreground/70 line-through",
        muted: "border-transparent bg-muted text-muted-foreground",
        info: "border-transparent bg-primary/20 text-primary",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

// Status-specific icons
const STATUS_ICONS: Record<string, React.ReactNode> = {
  queued: <Clock className="animate-spin-slow" />,
  processing: <Loader2 className="animate-spin" />,
  done: <CheckCircle />,
  error: <AlertCircle />,
  cancelled: <XCircle className="opacity-60" />,
};

interface BadgeProps
  extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
  icon?: React.ReactNode;
  animated?: boolean;
}

function Badge({
  className,
  variant = "default",
  asChild = false,
  icon,
  animated = true,
  children,
  ...props
}: BadgeProps) {
  const Comp = asChild ? Slot : "span";

  // Use status-specific icon if no custom icon provided and variant matches a status
  const statusIcon =
    icon ||
    (variant && variant in STATUS_ICONS && animated
      ? STATUS_ICONS[variant as keyof typeof STATUS_ICONS]
      : null);
  return (
    <Comp
      data-slot="badge"
      className={cn(
        badgeVariants({ variant }),
        // Ensure animations work with status icons
        statusIcon && "gap-1.5 [&>svg]:size-3.5",
        className,
      )}
      {...props}
    >
      {statusIcon}
      {children}
    </Comp>
  );
}

export { Badge, badgeVariants, STATUS_ICONS };
