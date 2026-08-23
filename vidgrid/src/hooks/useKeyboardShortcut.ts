import { useEffect } from "react";

/**
 * Checks whether the currently focused element is an editable field
 * (input, textarea, select, or contenteditable). Keyboard shortcuts
 * should not fire while the user is typing.
 */
function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;

  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if ((el as HTMLElement).isContentEditable) return true;

  return false;
}

/**
 * Returns true if any Radix dialog or alert-dialog overlay is visible.
 *
 * All modal surfaces in the app (Settings, TimestampEditor, GridTemplateEditor,
 * PreviewModal, confirmation dialogs, etc.) render a DialogOverlay or
 * AlertDialogOverlay with our styled wrapper.  Radix sets data-state="open"
 * on the overlay when the dialog is open.  Detecting the overlay is more
 * reliable than detecting the content element because some components
 * (TimestampEditor, GridTemplateEditor) use DialogPrimitive.Content directly
 * without our styled wrapper's data-slot attributes.
 */
function isModalOpen(): boolean {
  return (
    !!document.querySelector(
      '[data-slot="dialog-overlay"][data-state="open"]',
    ) ||
    !!document.querySelector(
      '[data-slot="alert-dialog-overlay"][data-state="open"]',
    )
  );
}

/** Configuration for a single keyboard shortcut. */
export interface ShortcutConfig {
  /** Key to match (e.g. "Enter", " ", "m", "ArrowLeft"). */
  key: string;
  /** Require Ctrl (or Cmd on macOS). Defaults to false. */
  ctrl?: boolean;
  /** Require Shift. Defaults to false. */
  shift?: boolean;
  /** Function to call when the shortcut is triggered. */
  callback: () => void;
  /** React dependency array; the listener is recreated when these change. */
  deps: unknown[];
  /**
   * Simple scoping: only active when an element with the matching
   * `data-dialog-scope` attribute is present in the DOM.
   *
   * When declared, the default global guard (blocked by any modal) is
   * replaced — the shortcut only fires when the scoped element is visible.
   *
   * Omit to use the default global guard (blocked when any modal is open).
   */
  scope?: string;
  /**
   * Complex scoping: custom activation logic.
   *
   * Takes precedence over `scope` if both are provided.
   * Also replaces the default global guard when declared.
   */
  isActive?: () => boolean;
}

function modifiersMatch(
  e: KeyboardEvent,
  config: Pick<ShortcutConfig, "ctrl" | "shift">,
): boolean {
  const wantCtrl = config.ctrl ?? false;
  const wantShift = config.shift ?? false;
  const hasCtrl = e.ctrlKey || e.metaKey;
  return hasCtrl === wantCtrl && e.shiftKey === wantShift;
}

/**
 * Returns true when an element with the given `data-dialog-scope` is
 * present in the DOM. Used to gate scoped shortcuts.
 */
function isScopeActive(scope: string): boolean {
  return !!document.querySelector(`[data-dialog-scope="${scope}"]`);
}

/**
 * Registers one or more keyboard shortcuts.
 *
 * The callback is invoked only when:
 * - The user presses the configured key with the required modifiers.
 * - Focus is NOT inside an editable field.
 *
 * @param configs - A single config object or an array of config objects.
 */
export function useKeyboardShortcut(
  configs: ShortcutConfig | ShortcutConfig[],
) {
  const list = Array.isArray(configs) ? configs : [configs];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused()) return;

      for (const cfg of list) {
        // Custom isActive takes precedence over everything
        if (cfg.isActive !== undefined && !cfg.isActive()) continue;

        // If scope is declared, only fire when that specific element is present
        if (cfg.scope !== undefined && !isScopeActive(cfg.scope)) continue;

        // Default (no scope, no isActive): block when ANY modal is open
        if (
          cfg.scope === undefined &&
          cfg.isActive === undefined &&
          isModalOpen()
        )
          continue;

        if (e.key === cfg.key && modifiersMatch(e, cfg)) {
          e.preventDefault();
          cfg.callback();
          // Only fire the first matching shortcut per keydown event.
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    JSON.stringify(
      list.map((c) => ({
        key: c.key,
        ctrl: c.ctrl,
        shift: c.shift,
        scope: c.scope,
        hasIsActive: c.isActive !== undefined,
      })),
    ),
    // Flatten all deps so the effect re-runs when any callback changes.
    ...(list.flatMap((c) => c.deps) ?? []),
  ]);
}
