/** Thin wrapper around nativeApi.probeMetadata (real ffprobe, via the local backend). */

import type { VideoMetadata } from "../types";
import { nativeApi } from "./nativeApi";

export async function probeMetadata(path: string): Promise<VideoMetadata> {
  return nativeApi.probeMetadata(path);
}
