import { describe, expect, it } from "@effect/vitest";

import type { Summary } from "./Archiver.ts";
import { printable, statusLine, summaryLines } from "./format.ts";

describe("format", () => {
  it("keeps remote text from rewriting a terminal", () => {
    const hostile = "Title\u001b[2J\u001b[31m\nforged line\r";
    const summary: Summary = {
      total: 1,
      archived: 0,
      skipped: 0,
      failed: [{ id: "1", title: hostile, message: hostile }],
      partial: 0,
      failedParts: 0,
      failedImages: 0,
      bytes: 0,
    };

    expect(printable(hostile)).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(summaryLines(summary)).toHaveLength(2);
    expect(summaryLines(summary).join("")).not.toContain("\u001b");
    expect(
      statusLine({ id: "1", title: hostile, numParts: 1, modifyDate: "", state: "new" }),
    ).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});
