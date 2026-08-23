import * as React from "react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useHoverArm } from "@/lib/useHoverArm";

interface Props {
  /** Unique ID for the input (used for both range and number inputs). */
  id: string;
  /** Current numeric value. */
  value: number;
  /** Minimum value for the slider track. */
  min: number;
  /** Maximum value for the slider track. */
  max: number;
  /** Step increment. */
  step?: number;
  /** Callback when the value changes (called on every change). */
  onChange: (v: number) => void;
  /** Optional suffix/unit displayed after the value, e.g. "px". */
  suffix?: string;
  /** Whether to show the numeric text input (default true). */
  showTextField?: boolean;
  /** Additional classes for the root container. */
  className?: string;
  /** When true, the control is disabled (slider + text input). */
  disabled?: boolean;
  /** When true, allows text input values outside [min, max] range. */
  unbounded?: boolean;
  /** Invisible absolute minimum (defaults to min if not provided). */
  hardMin?: number;
  /** Invisible absolute maximum (defaults to max if not provided). */
  hardMax?: number;
  /** Custom width for the text input field (CSS width string like "100px" or "8rem"). When not provided, defaults to "w-21" (84px). */
  textInputWidth?: string;
}

/**
 * A compact range slider paired with a small numeric text field.
 *
 * The slider allows quick adjustment while the text field allows precise
 * direct entry. Both are kept in sync. When `unbounded` is true, the text
 * field allows values outside [min, max] (bounded by hardMin/hardMax).
 */
export default function RangeNumberInput({
  id,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  showTextField = true,
  className,
  disabled = false,
  unbounded = false,
  hardMin,
  hardMax,
  textInputWidth,
}: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [hoverRef, isArmed] = useHoverArm(250);
  const onChangeRef = React.useRef(onChange);
  const valueRef = React.useRef(value);
  onChangeRef.current = onChange;
  valueRef.current = value;

  // Merge containerRef and hoverRef so both are attached to the root div.
  const setNode = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    (hoverRef as React.RefObject<HTMLDivElement | null>).current = node;
  };

  const actualMin = hardMin ?? min;
  const actualMax = hardMax ?? max;

  // Clamp to slider range unless unbounded, then clamp to hard limits.
  const clamp = (n: number) =>
    unbounded
      ? Math.max(actualMin, Math.min(actualMax, n))
      : Math.max(min, Math.min(max, n));

  // Adjust value by step (used for wheel and arrow key handlers).
  const adjustValue = (delta: number) => {
    const next = clamp(valueRef.current + step * delta);
    onChangeRef.current(next);
    setDraft(String(next));
  };

  // Register native wheel listener with { passive: false } so preventDefault
  // actually blocks page scrolling while the control is armed.
  // The control only arms after the cursor has rested for the configured delay,
  // preventing inadvertent value changes while scrolling through the page.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: WheelEvent) => {
      if (disabled || !isArmed.current) return;
      if (e.deltaY !== 0) {
        e.preventDefault();
        adjustValue(e.deltaY > 0 ? -1 : 1);
      }
    };

    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [disabled, step, unbounded, min, max, actualMin, actualMax]);

  // Internal "draft" state for the text field so non-numeric keystrokes
  // don't cause immediate re-renders. Committed on blur / Enter.
  const [draft, setDraft] = React.useState(String(value));
  const draftRef = React.useRef(draft);
  draftRef.current = draft;

  // Dynamically measure suffix width so input padding adjusts to any suffix length.
  const suffixRef = React.useRef<HTMLSpanElement>(null);
  const [suffixWidth, setSuffixWidth] = React.useState(0);

  React.useEffect(() => {
    if (!suffixRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSuffixWidth(entry.contentRect.width);
      }
    });
    ro.observe(suffixRef.current);
    return () => ro.disconnect();
  }, [suffix]);

  // Keep draft in sync when value changes from outside (e.g. preset restore).
  React.useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commitFromDraft = () => {
    const raw = Number(draftRef.current);
    const clamped = clamp(isNaN(raw) ? actualMin : raw);
    onChange(clamped);
    setDraft(String(clamped));
  };

  // Whether the current value is outside the slider's recommended range.
  const isOutOfRange = value < min || value > max;

  return (
    <div ref={setNode} className={cn("flex items-center gap-3", className)}>
      <Slider
        id={id}
        min={min}
        max={max}
        step={step}
        value={[Math.max(min, Math.min(max, value))]}
        onValueChange={([v]) => onChange(v)}
        disabled={disabled}
        className={cn("flex-1", disabled && "opacity-50")}
      />
      {showTextField && (
        <div className="relative shrink-0">
          <Input
            id={`${id}-text`}
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitFromDraft}
            disabled={disabled}
            onKeyDown={(e) => {
              if (disabled) return;
              if (e.key === "Enter") {
                e.preventDefault();
                commitFromDraft();
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                adjustValue(1);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                adjustValue(-1);
              }
            }}
            className={cn(
              "text-right tabular-nums",
              !textInputWidth && "w-21",
              isOutOfRange && "border-ring",
            )}
            style={{
              ...(textInputWidth ? { width: textInputWidth } : {}),
              ...(suffix ? { paddingRight: `${suffixWidth + 16}px` } : {}),
            }}
          />
          {suffix && (
            <span
              ref={suffixRef}
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs"
            >
              {suffix}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
