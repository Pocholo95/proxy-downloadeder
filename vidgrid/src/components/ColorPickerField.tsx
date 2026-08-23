import { Check } from "lucide-react";
import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerAreaGradient,
  ColorPickerAreaThumb,
  ColorPickerHueSlider,
  ColorPickerHueSliderTrack,
  ColorPickerHueSliderThumb,
  ColorPickerInput,
  ColorPickerInputTrigger,
  ColorPickerContent,
} from "@markoradak/color-picker";
import type { ColorPickerValue } from "@markoradak/color-picker";
import { Field, FieldLabel } from "@/components/ui/field";
import { normalizeHex } from "@/utils";

import { COLOR_SWATCHES } from "@/constants";

interface Props {
  /** Label shown above the picker. */
  label: string;
  /** HTML id for the trigger input (used by FieldLabel). */
  id: string;
  /** Current hex color value. */
  value: string;
  /** Called whenever the color changes. */
  onChange: (color: string) => void;
  /** Fallback color when the picker value is invalid. */
  fallback: string;
  /** Optional override for swatch colors. Defaults to a curated palette. */
  swatches?: string[];
}

/**
 * A reusable color picker field using @markoradak/color-picker composable API.
 * Theme-aware styling using Tailwind CSS variables.
 *
 * Decoupled from SavedOptions so it can be reused in any form context.
 */
export default function ColorPickerField({
  label,
  id,
  value,
  onChange,
  fallback,
  swatches = [...COLOR_SWATCHES],
}: Props) {
  const handleValueChange = (v: ColorPickerValue) => {
    onChange(normalizeHex(v, fallback));
  };

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <ColorPicker
          value={value}
          onValueChange={handleValueChange}
          autoTokens={false}
        >
          <ColorPickerInputTrigger
            id={id}
            enableEyeDropper={false}
            className="inline-flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg border border-border dark:bg-input/30 dark:hover:bg-input/50 px-1.5 text-left outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background"
            classNames={{
              thumbnail: "h-7 w-7 shrink-0 rounded-md",
              thumbnailCheckerboard: "hidden",
              thumbnailSwatch: "rounded-md",
              formatToggle:
                "shrink-0 cursor-pointer rounded-md px-1 text-xs opacity-50 outline-none hover:opacity-80",
              input:
                "w-full cursor-text bg-transparent font-mono text-sm outline-none flex items-center pointer-events-none",
            }}
          />
          <ColorPickerContent className="z-50 flex w-80 flex-col gap-3 rounded-xl border border-border bg-popover p-3 shadow-lg text-popover-foreground">
            <ColorPickerArea className="relative h-44 w-full cursor-crosshair rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ColorPickerAreaGradient className="rounded-lg" />
              <ColorPickerAreaThumb className="h-4 w-4 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.2),inset_0_0_0_1px_rgba(0,0,0,0.1)]" />
            </ColorPickerArea>
            <ColorPickerHueSlider className="relative h-3 w-full cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ColorPickerHueSliderTrack className="rounded-full" />
              <ColorPickerHueSliderThumb className="h-4 w-4 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.2)]" />
            </ColorPickerHueSlider>
            <ColorPickerInput
              className="flex items-center gap-1"
              classNames={{
                formatToggle:
                  "shrink-0 select-none rounded-md border border-border bg-popover px-2 h-8 text-xs font-medium outline-none hover:bg-muted",
                field:
                  "w-full rounded-md border border-border bg-popover px-2 h-8 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring",
              }}
            />
            <div className="flex gap-1">
              {swatches.map((c) => {
                const isActive = value.toLowerCase() === c.toLowerCase();
                return (
                  <button
                    key={c}
                    type="button"
                    className={
                      "relative h-5 flex-1 cursor-pointer rounded-sm border border-border outline-none transition-colors hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring" +
                      (isActive ? " ring-2 ring-ring" : "")
                    }
                    style={{ backgroundColor: c }}
                    onClick={() => handleValueChange(c)}
                    title={c}
                  >
                    {isActive && (
                      <Check
                        className="absolute inset-0 m-auto size-3"
                        strokeWidth={3}
                        style={{
                          color:
                            c === "#000000" || c === "#000" ? "#fff" : "#000",
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </ColorPickerContent>
        </ColorPicker>
      </div>
    </Field>
  );
}
