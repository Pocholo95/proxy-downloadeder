/**
 * CORSHelpModal – shown when an upload fails due to CORS restrictions and no
 * userscript proxy is available.  Guides the user to install a userscript
 * manager and download the CORS Tunnel userscript.
 */
import { Fragment, useEffect, useState } from "react";
import { ExternalLink, Code, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  detectBrowserExtension,
  downloadUserscript,
  dismissModalPermanently,
  clearModalShown,
} from "@/lib/cors-tunnel";
import { useSettingsStore } from "@/store/settingsStore";
import UserscriptViewer from "./UserscriptViewer";
import { PROJECT_NAME } from "@/constants";

interface CORSHelpModalProps {
  open: boolean;
  onClose: () => void;
}

export default function CORSHelpModal({ open, onClose }: CORSHelpModalProps) {
  const [showViewer, setShowViewer] = useState(false);
  // Read the current setting from the Zustand store so the switch always
  // reflects the real value (not a stale local state).
  const corsModalDismissed = useSettingsStore(
    (s) => !!s.settings.corsModalDismissed,
  );
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // Local tracking for the "don't show again" toggle so we can decide what
  // to do on close.  Synced with the store value whenever the modal opens.
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Whenever the modal opens, initialize local state from the current setting.
  useEffect(() => {
    if (open) {
      setDontShowAgain(corsModalDismissed);
    }
  }, [open, corsModalDismissed]);

  const extension = detectBrowserExtension();

  const handleClose = async () => {
    if (dontShowAgain) {
      await dismissModalPermanently();
    } else {
      // Reset the per-batch flag so the modal can show again on the next
      // CORS error in a subsequent upload attempt.
      clearModalShown();
      // Also make sure the setting is false in case it was toggled via
      // the settings dialog while the modal was open.
      if (corsModalDismissed) {
        updateSettings({ corsModalDismissed: false });
      }
    }
    onClose();
  };

  return (
    <Fragment>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>CORS Upload Blocked</DialogTitle>
            <DialogDescription>
              The upload was blocked by the browser's cross-origin security
              policy. Some image hosts do not allow requests from websites other
              than their own. The CORS Tunnel userscript bypasses this
              restriction by running inside your browser.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* Step 1: Install userscript manager */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                1
              </span>
              <div className="flex-1 flex flex-col gap-1">
                <p className="text-sm font-medium">
                  Install a userscript manager{" "}
                  {extension.detected ? "(already detected)" : "(required)"}
                </p>
                <p className="text-muted-foreground text-xs">
                  A userscript manager allows browser-side scripts to bypass
                  CORS restrictions on behalf of this app.
                </p>
                {!extension.detected && (
                  <a
                    href={extension.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary text-xs inline-flex items-center gap-1 hover:underline"
                  >
                    Download {extension.name}{" "}
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            </div>

            {/* Step 2: Install the userscript */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                2
              </span>
              <div className="flex-1 flex flex-col gap-1">
                <p className="text-sm font-medium">
                  Install the {PROJECT_NAME} CORS Tunnel userscript
                </p>
                <p className="text-muted-foreground text-xs">
                  Download or View/Copy the userscript file and import it in
                  your userscript manager (e.g. Dashboard → New Script).
                </p>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadUserscript}
                  >
                    <Download className="size-3 mr-1" />
                    Download
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowViewer(true)}
                  >
                    <Code className="size-3 mr-1" />
                    View Code
                  </Button>
                </div>
              </div>
            </div>

            {/* Step 3: Retry */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                3
              </span>
              <div className="flex-1 flex flex-col gap-1">
                <p className="text-sm font-medium">
                  Refresh the page and retry the upload
                </p>
                <p className="text-muted-foreground text-xs">
                  After installing and enabling the userscript, you have to
                  refresh the {PROJECT_NAME} page, process the tasks again, and
                  retry the upload. The request will be proxied automatically
                  and should succeed.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter className="flex-row items-center justify-between sm:justify-between">
            <div className="flex items-center gap-2">
              <Switch
                id="cors-dont-show-again"
                checked={dontShowAgain}
                onCheckedChange={(v) => setDontShowAgain(Boolean(v))}
              />
              <label
                htmlFor="cors-dont-show-again"
                className="text-sm text-muted-foreground cursor-pointer select-none"
              >
                Don't show this again
              </label>
            </div>
            <Button onClick={handleClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UserscriptViewer
        open={showViewer}
        onClose={() => setShowViewer(false)}
      />
    </Fragment>
  );
}
