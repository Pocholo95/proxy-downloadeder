/**
 * UserscriptViewer – dialog that displays the generated userscript source
 * code with syntax highlighting and a copy button.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { generateUserscriptContent } from "@/lib/cors-tunnel";
import { PROJECT_NAME } from "@/constants";

interface UserscriptViewerProps {
  open: boolean;
  onClose: () => void;
}

export default function UserscriptViewer({
  open,
  onClose,
}: UserscriptViewerProps) {
  const [copied, setCopied] = useState(false);

  // Generate content on open; cache it so closing/reopening doesn't regenerate.
  const [content, setContent] = useState<string>("");

  if (open && !content) {
    try {
      setContent(generateUserscriptContent(window.location.origin));
    } catch {
      setContent("// Failed to generate userscript content");
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement("textarea");
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{PROJECT_NAME} CORS Tunnel Userscript</DialogTitle>
          <DialogDescription>
            This is the userscript source code. Copy it or download the file to
            import into your userscript manager. You have to refresh the{" "}
            {PROJECT_NAME} page after you have installed and enabled the script.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-4 text-xs leading-relaxed whitespace-pre-wrap break-all">
            <code>{content}</code>
          </pre>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className="absolute top-2 right-3"
          >
            {copied ? (
              <>
                <Check className="size-3 mr-1" />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-3 mr-1" />
                Copy
              </>
            )}
          </Button>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
