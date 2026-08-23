import type {
  TaskItem,
  UploadDestination,
  UploadResult,
  VideoMetadata,
} from "./types";
import { buildBbcodeTitleLine, withoutExtension } from "./utils";

/**
 * Get files to upload for a task (gallery images or single output file).
 */
export function getUploadFiles(
  item: TaskItem,
): Array<{ blob: Blob; name: string }> {
  // Gallery mode: return all frame images
  if (item.galleryImages && item.galleryImages.length > 0) {
    return item.galleryImages.map((blob, i) => ({
      blob,
      name: item.galleryImageNames?.[i] ?? `${item.outputName}_${i}.jpg`,
    }));
  }
  // Single file mode (video, image, etc.): return the output blob
  if (item.outputBlob && item.outputName) {
    return [{ blob: item.outputBlob, name: item.outputName }];
  }
  return [];
}

/**
 * Parse a comma-separated extensions string into a normalized set of
 * lowercase extensions (each starting with ".").
 */
/**
 * Parse a comma-separated extensions string into a normalized set of
 * lowercase extensions (each starting with "."). Empty string means
 * "allow all extensions".
 */
export function parseAllowedExtensions(
  raw: string | undefined,
): Set<string> | null {
  if (raw === undefined) return null; // treat missing as allow all
  const trimmed = raw.trim();
  if (trimmed === "") return null; // null means allow all
  return new Set(
    trimmed
      .split(",")
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
      .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`)),
  );
}

/**
 * Check whether a task's output file is eligible for upload to a given
 * destination based on extension and file size constraints.
 *
 * @param outputName - The task's output filename.
 * @param outputSize - The task's output file size in bytes (0 | undefined = unknown).
 * @param destination - The upload destination to check against.
 * @returns true if the file matches the destination's allowed extensions and
 *          size constraints.
 */
export function isUploadEligible(
  outputName: string | undefined,
  outputSize: number | undefined,
  destination: UploadDestination,
): boolean {
  if (!outputName) return false;

  // Extract file extension (lowercase, with leading dot)
  const match = outputName.toLowerCase().match(/\.([^.]+)$/);
  if (!match) return false;
  const ext = `.${match[1]}`;
  const allowed = parseAllowedExtensions(destination.allowedExtensions);

  // null (empty string) means allow all extensions
  if (allowed !== null && !allowed.has(ext)) {
    return false;
  }

  // Check file size against destination's max (0 = unlimited, undefined = unlimited)
  const sizeLimit = destination.maxSizeMb ?? 0;
  if (
    sizeLimit > 0 &&
    outputSize !== undefined &&
    outputSize > 0 &&
    outputSize > sizeLimit * 1024 * 1024
  ) {
    return false;
  }

  return true;
}

/**
 * Check whether a TaskItem is eligible for upload to a given destination.
 * For gallery tasks, checks gallery image extensions instead of outputName
 * (which is the original video filename, e.g. .mp4, not .jpg).
 */
export function isItemUploadEligible(
  item: {
    outputName?: string;
    outputSize?: number;
    galleryImageNames?: string[];
  },
  destination: UploadDestination,
): boolean {
  // Gallery mode: check gallery image names, not the video outputName
  if (item.galleryImageNames && item.galleryImageNames.length > 0) {
    return item.galleryImageNames.some((name) =>
      isUploadEligible(name, undefined, destination),
    );
  }
  return isUploadEligible(item.outputName, item.outputSize, destination);
}

export type LinkFormat = {
  key: string;
  label: string;
  value: string;
  description: string;
  fieldType?: "input" | "textarea";
};

/**
 * Derives a human-readable resolution label (e.g. "1080p") from pixel height,
 * with BBCode color tags for forum use. Returns an empty string if metadata
 * is missing or height is zero.
 *
 * @param meta - Optional VideoMetadata; height is used to pick the label.
 * @returns The formatted resolution label, or an empty string.
 */
export const resolutionLabel = (meta?: VideoMetadata): string => {
  if (!meta || meta.height === 0) return "";
  const h = Math.min(meta.width, meta.height);
  if (h >= 2160) return "[COLOR=rgb(85, 57, 130)]2160p[/COLOR]";
  if (h >= 1440) return "[COLOR=rgb(251, 160, 38)]1440p[/COLOR]";
  if (h >= 1080) return "[COLOR=rgb(184, 49, 47)]1080p[/COLOR]";
  if (h >= 720) return "[COLOR=rgb(250, 197, 28)]720p[/COLOR]";
  if (h >= 480) return "[COLOR=rgb(0, 0, 0)]480p[/COLOR]";
  if (h >= 360) return "[COLOR=rgb(204, 204, 204)]360p[/COLOR]";
  return `${h}p`;
};

/**
 * Build the list of copyable link formats for a given upload result.
 * Each item uses a named key so callers do not depend on array positions.
 *
 * @param r - The UploadResult from the host.
 * @param filename - Original output filename.
 * @param canHotlink - Whether direct hotlinking is supported by the provider.
 * @param metadata - Optional video metadata used for the post template title.
 * @returns The available link formats for the upload result.
 */
export const buildFormats = (
  r: UploadResult,
  filename: string,
  canHotlink: boolean,
  metadata?: VideoMetadata,
): LinkFormat[] => {
  const filenameNoExt = withoutExtension(filename);

  // When thumbUrl equals pageUrl, it means no real thumbnail image is available
  // (e.g. Filester .webp uploads where thumbnail_url points to a 404).
  // In that case, thumbUrl is a viewer page URL, not an image URL, so it
  // cannot be used inside [img], markdown images, or HTML <img> tags.
  const hasRealThumbnail = r.thumbUrl !== r.pageUrl;

  // For non-hotlinkable hosts (e.g. Filester), directUrl cannot be used in [img] tags.
  // We fall back to the thumbnail URL instead, wrapped in a [url] link.
  // If no real thumbnail exists, use a plain text link instead.
  let bbcodeFullImage: string;
  let bbcodeFullDesc: string;
  if (canHotlink) {
    bbcodeFullImage = `[img]${r.directUrl}[/img]`;
    bbcodeFullDesc = "Displays the image inline";
  } else if (hasRealThumbnail) {
    bbcodeFullImage = `[url=${r.directUrl}][img]${r.thumbUrl}[/img][/url]`;
    bbcodeFullDesc = "Thumbnail that links to the full image";
  } else {
    bbcodeFullImage = `[url=${r.directUrl}]${filenameNoExt}[/url]`;
    bbcodeFullDesc =
      "Link to the viewer page (no hot-linking/thumbnail possible)";
  }

  // Markdown/HTML: link the thumbnail to the direct URL (or viewer page as fallback)
  const linkTarget = r.directUrl || r.pageUrl;
  let markdownImage: string;
  let markdownDesc: string;
  let htmlImage: string;
  let htmlDesc: string;
  if (canHotlink) {
    markdownImage = `![${filenameNoExt}](${r.directUrl})`;
    markdownDesc = "For GitHub, GitLab, Reddit…";
    htmlImage = `<img src="${r.directUrl}" alt="${filenameNoExt}" />`;
    htmlDesc = "Inline HTML image tag";
  } else if (hasRealThumbnail) {
    markdownImage = `[![${filenameNoExt}](${r.thumbUrl})](${linkTarget})`;
    markdownDesc = "Thumbnail that links to the viewer page";
    htmlImage = `<a href="${linkTarget}"><img src="${r.thumbUrl}" alt="${filenameNoExt}" /></a>`;
    htmlDesc = "Thumbnail image linked to the full image";
  } else {
    markdownImage = `[${filenameNoExt}](${linkTarget})`;
    markdownDesc =
      "Link to the viewer page (no hot-linking/thumbnail possible)";
    htmlImage = `<a href="${linkTarget}">${filenameNoExt}</a>`;
    htmlDesc = "Link to the viewer page (no hot-linking/thumbnail possible)";
  }

  // BBCode thumbnail format
  let bbcodeThumbValue: string;
  let bbcodeThumbDesc: string;
  if (hasRealThumbnail) {
    bbcodeThumbValue = `[url=${r.pageUrl}][img]${r.thumbUrl}[/img][/url]`;
    bbcodeThumbDesc = "Thumbnail that links to the viewer page";
  } else {
    bbcodeThumbValue = `[url=${r.pageUrl}]${filenameNoExt}[/url]`;
    bbcodeThumbDesc =
      "Link to the viewer page (no hot-linking/thumbnail possible)";
  }

  // Post Template: for webp files, use directUrl to preserve animation.
  // But when canHotlink is false, directUrl is a viewer page URL (not embeddable),
  // so use a plain text link instead.
  // Use buildBbcodeTitleLine to unify title+resolution formatting.
  const titleLine = buildBbcodeTitleLine(filenameNoExt, metadata);
  let postTemplateValue: string;
  if (canHotlink) {
    postTemplateValue = `${titleLine}\n[url=${r.pageUrl}][img]${(filename.endsWith(".webp") ? r.directUrl : r.mediumUrl) ?? r.thumbUrl}[/img][/url]`;
  } else if (hasRealThumbnail) {
    postTemplateValue = `${titleLine}\n[url=${r.pageUrl}][img]${r.mediumUrl ?? r.thumbUrl}[/img][/url]`;
  } else {
    postTemplateValue = `${titleLine}\n[url=${r.pageUrl}]${filenameNoExt}[/url]`;
  }

  const formats: LinkFormat[] = [
    {
      key: "bbcodeFull",
      label: "BBCode — full image",
      value: bbcodeFullImage,
      description: bbcodeFullDesc,
    },
    {
      key: "bbcodeThumb",
      label: "BBCode — thumbnail → full",
      value: bbcodeThumbValue,
      description: bbcodeThumbDesc,
    },
    {
      key: "bbcodePostTemplate",
      label: "BBCode — Post Template",
      value: postTemplateValue,
      description: "Forum-style template for this upload",
      fieldType: "textarea",
    },
    {
      key: "directUrl",
      label: "Direct URL",
      value: r.directUrl,
      description: "Full-resolution image link",
    },
    {
      key: "pageUrl",
      label: "Viewer page",
      value: r.pageUrl,
      description: "Host viewer page",
    },
    {
      key: "markdown",
      label: "Markdown",
      value: markdownImage,
      description: markdownDesc,
    },
    {
      key: "htmlImg",
      label: "HTML img",
      value: htmlImage,
      description: htmlDesc,
    },
  ];

  if (r.mediumUrl) {
    formats.splice(3, 0, {
      key: "bbcodeMedium",
      label: "BBCode — medium → full",
      value: `[url=${r.pageUrl}][img]${r.mediumUrl}[/img][/url]`,
      description: "Medium image that links to the viewer page",
    });
  }

  return formats;
};
