/**
 * HTTP JSON bridge to the local desktop/ Python backend (desktop/api.py,
 * routed through desktop/media_server.py's /api/* endpoints). Replaces the
 * old window.pywebview.api bridge now that the UI runs in the user's
 * regular browser tab instead of an embedded native webview -- same-origin
 * fetch() calls to the server that's already serving this page.
 */

import type { VideoMetadata } from "../types";

export interface ScannedFile {
  name: string;
  path: string;
  size: number;
  lastModified: number;
  token: string;
}

export interface SharedDirEntry {
  /** Directory name (basename only). */
  name: string;
  /** Path relative to the shared dir root, e.g. "sub/nested" -- pass this
   *  straight back into listSharedDir() to navigate into it. */
  path: string;
}

export interface SharedDirListing {
  /** The relative path actually listed (== the subpath argument, normalized). */
  path: string;
  dirs: SharedDirEntry[];
  files: ScannedFile[];
}

async function call<T>(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const isJson = res.headers.get("Content-Type")?.includes("application/json");
  const data = isJson ? await res.json() : undefined;
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

export const nativeApi = {
  checkFfmpeg: () =>
    call<{ ffmpeg: boolean; ffprobe: boolean }>("/api/check_ffmpeg", "GET"),
  getCpuCount: () =>
    call<{ count: number }>("/api/cpu_count", "GET").then((r) => r.count),

  /** A folder the backend suggests as a one-click scan_path shortcut (e.g.
   *  another app's shared downloads volume in a combined deploy) -- empty
   *  string if none is configured (VIDGRID_SHARED_DIR unset). */
  getSharedDir: () =>
    call<{ path: string }>("/api/shared_dir", "GET").then((r) => r.path),

  /**
   * Scans a filesystem path (a single file, or a folder recursively) on
   * the machine the backend is running on -- no upload, since the app and
   * the files already live on the same machine. Much faster than
   * uploadInput for large batches/whole folders.
   */
  scanPath: (path: string) =>
    call<ScannedFile[]>("/api/scan_path", "POST", { path }),

  /**
   * Lists one level of the shared directory (folders + video files
   * directly inside `subpath`, no recursion) -- for browsing it folder by
   * folder instead of scanPath's full recursive flatten. `subpath` is
   * relative to the shared dir root; "" lists the root itself.
   */
  listSharedDir: (subpath = "") =>
    call<SharedDirListing>("/api/list_shared_dir", "POST", { subpath }),

  /**
   * Streams a browser-picked File's bytes to a local temp copy on the
   * backend and returns its real filesystem path + a /media/<token> for
   * preview playback -- browsers don't expose real paths from
   * <input type=file>, and ffmpeg needs one to operate on.
   */
  uploadInput: async (file: File): Promise<{ path: string; token: string }> => {
    const res = await fetch(
      `/api/upload_input?name=${encodeURIComponent(file.name)}`,
      { method: "POST", body: file },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = `${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          message = String(parsed.error);
        }
      } catch {
        /* not JSON -- fall back to the status line above */
      }
      throw new Error(message);
    }
    return res.json();
  },

  probeMetadata: (path: string) =>
    call<VideoMetadata>("/api/probe_metadata", "POST", { path }),

  registerMedia: (path: string) =>
    call<{ token: string }>("/api/register_media", "POST", { path }),

  bindInputPath: (taskId: string, path: string) =>
    call<void>("/api/tasks/bind_input", "POST", { taskId, path }),
  execFfmpeg: (taskId: string, args: string[], durationHint?: number | null) =>
    call<void>("/api/tasks/exec", "POST", { taskId, args, durationHint }),
  writeTaskFile: (taskId: string, filename: string, dataB64: string) =>
    call<void>("/api/tasks/write_file", "POST", { taskId, filename, dataB64 }),
  readTaskFile: (taskId: string, filename: string) =>
    call<{ dataB64: string }>("/api/tasks/read_file", "POST", {
      taskId,
      filename,
    }).then((r) => r.dataB64),
  listTaskDir: (taskId: string, subpath = "") =>
    call<{ entries: string[] }>("/api/tasks/list_dir", "POST", {
      taskId,
      subpath,
    }).then((r) => r.entries),
  deleteTaskFile: (taskId: string, filename: string) =>
    call<void>("/api/tasks/delete_file", "POST", { taskId, filename }),
  abortTask: (taskId: string) =>
    call<void>("/api/tasks/abort", "POST", { taskId }),
  resetTask: (taskId: string) =>
    call<void>("/api/tasks/reset", "POST", { taskId }),
};
