import { OUTPUT_MODES } from "../../constants";
import type { OutputMode } from "../../types";

interface Props {
  value: OutputMode;
  onChange: (mode: OutputMode) => void;
}

export default function OutputModeCards({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-4 gap-2 sm:gap-3">
      {OUTPUT_MODES.map((mode) => {
        const Icon = mode.icon;
        const selected = value === mode.value;
        return (
          <button
            key={mode.value}
            type="button"
            className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 p-2 sm:p-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              selected
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
            }`}
            onClick={() => onChange(mode.value)}
            title={mode.description}
          >
            <Icon className="size-5 sm:size-6" />
            <span className="text-xs font-medium sm:text-sm">{mode.title}</span>
            <span className="hidden text-[10px] sm:text-xs text-muted-foreground text-center leading-tight sm:block">
              {mode.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}
