import * as Schema from "effect/Schema";

import type { LibraryStatus, Summary } from "./Archiver.ts";

export const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** One line, plus one per failed story. Nothing else is printed unless something needs attention. */
export const summaryLines = (summary: Summary): ReadonlyArray<string> => {
  const parts = [
    `Archived ${summary.archived} of ${summary.total} stories`,
    `${summary.skipped} up to date`,
    formatBytes(summary.bytes),
  ];
  if (summary.partial > 0) {
    parts.push(`${summary.partial} missing ${summary.failedParts} chapters, retried next run`);
  }
  if (summary.failedImages > 0)
    parts.push(`${summary.failedImages} images could not be downloaded`);
  if (summary.failed.length > 0) parts.push(`${summary.failed.length} failed`);
  return [
    parts.join(", "),
    ...summary.failed.map((failure) => `failed ${failure.id} ${failure.title}: ${failure.message}`),
  ];
};

export const statusLine = (story: LibraryStatus) =>
  `${story.state.padEnd(8)} ${story.id.padStart(10)} ${String(story.numParts).padStart(5)}  ${story.title}`;
