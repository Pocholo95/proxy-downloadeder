/**
 * CORSOutdatedModal – shown when the userscript is detected but running an
 * outdated version.  Guides the user to update by downloading the new
 * version or copying the updated code.
 */
import { Fragment, useState } from "react";
import { Code, Download, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  downloadUserscript,
  USERSCRIPT_VERSION,
  getInstalledVersion,
} from "@/lib/cors-tunnel";
import UserscriptViewer from "./UserscriptViewer";
import { PROJECT_NAME } from "@/constants";

interface CORSOutdatedModalProps {
  open: boolean;
  onClose: () => void;
}

export default function CORSOutdatedModal({
  open,
  onClose,
}: CORSOutdatedModalProps) {
  const [showViewer, setShowViewer] = useState(false);
  const installedVersion = getInstalledVersion() ?? "unknown";

  return (
    <Fragment>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-500" />
              Userscript Out of Date
            </DialogTitle>
            <DialogDescription>
              The {PROJECT_NAME} CORS Tunnel userscript is installed but running
              an outdated version.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* Version info */}
            <div className="rounded-lg border bg-muted/50 p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Installed:</span>
                <span className="font-mono font-medium">
                  v{installedVersion}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Required:</span>
                <span className="font-mono font-medium text-primary">
                  v{USERSCRIPT_VERSION}
                </span>
              </div>
            </div>

            {/* Update instructions */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                1
              </span>
              <div className="flex-1 flex flex-col gap-1">
                <p className="text-sm font-medium">
                  Download the updated userscript
                </p>
                <p className="text-muted-foreground text-xs">
                  Download the new version below, then in your userscript
                  manager (Tampermonkey etc.) find the existing{" "}
                  <strong>{PROJECT_NAME} CORS Tunnel</strong> script and either
                  replace its code with the new one, or uninstall it first and
                  import the downloaded file.
                </p>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={downloadUserscript}
                  >
                    <Download className="size-3 mr-1" />
                    Download Updated Version
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

            {/* Step 2 */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                2
              </span>
              <div className="flex-1 flex flex-col gap-1">
                <p className="text-sm font-medium">
                  Update the script in your userscript manager
                </p>
                <p className="text-muted-foreground text-xs">
                  Open your userscript manager, locate the existing{" "}
                  <strong>{PROJECT_NAME} CORS Tunnel</strong> entry, and either:
                  <br />
                  <span className="ml-4">• Edit it and paste the new code</span>
                  <br />
                  <span className="ml-4">
                    • Delete it, then import the downloaded file
                  </span>
                </p>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                3
              </span>
              <div className="flex-1 flex flex-col gap-1">
                <p className="text-sm font-medium">
                  Refresh the page and retry the upload
                </p>
                <p className="text-muted-foreground text-xs">
                  After updating the userscript, refresh {PROJECT_NAME} and
                  retry your upload.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={onClose}>Close</Button>
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
