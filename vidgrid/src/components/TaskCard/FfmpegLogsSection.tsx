import { useEffect, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  logs: string[];
  totalLines?: number;
  isProcessing?: boolean;
  isStale?: boolean;
  onForceCancel?: () => void;
}

export default function FfmpegLogsSection({
  logs,
  totalLines,
  isProcessing,
  isStale,
  onForceCancel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);

  /** Auto-scroll to bottom when new log lines are appended. */
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    /* New lines were added (logs.length grew). */
    if (logs.length > prevLengthRef.current) {
      /* Only auto-scroll if the user is already scrolled near the bottom
         (within the last 60px) so we don't fight manual scrolling up. */
      const nearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        60;

      if (nearBottom || container.scrollTop === 0) {
        container.scrollTop = container.scrollHeight;
      }

      prevLengthRef.current = logs.length;
    }
  }, [logs.length]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(logs.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* fallback for older browsers */
      const ta = document.createElement("textarea");
      ta.value = logs.join("\n");
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const lineLabel =
    totalLines && logs.length < totalLines
      ? `${logs.length} / ${totalLines} total`
      : `${logs.length}`;

  return (
    <div className="border rounded-md">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium">
        <button
          type="button"
          className="flex items-center gap-2 hover:text-foreground flex-1"
          onClick={() => setOpen((s) => !s)}
        >
          <Terminal className="size-3" />
          FFmpeg Logs ({lineLabel} lines)
        </button>
        {isProcessing && onForceCancel && (
          <Button
            variant="destructive"
            size="sm"
            onClick={onForceCancel}
            title="Force-kill FFmpeg for this file and move on"
            className={cn("shrink-0", isStale && "animate-pulse")}
          >
            <Ban className="size-3" />
            Kill
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          title="Copy logs to clipboard"
          className="shrink-0 h-6 px-2 text-[10px]"
        >
          {copied ? (
            <Check className="size-3 text-green-500" />
          ) : (
            <Copy className="size-3" />
          )}
        </Button>
        <button
          type="button"
          className="shrink-0 hover:text-foreground"
          onClick={() => setOpen((s) => !s)}
        >
          {open ? (
            <ChevronUp className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </button>
      </div>
      {open && (
        <div
          ref={scrollRef}
          className="max-h-48 overflow-auto bg-muted/50 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre"
        >
          {logs.length === 0
            ? "\u{1F55C} Initializing FFmpeg..."
            : logs.join("\n")}
        </div>
      )}
    </div>
  );
}
