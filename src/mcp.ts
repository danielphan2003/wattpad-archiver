import * as NodeStdio from "@effect/platform-node/NodeStdio";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";

import * as Archiver from "./Archiver.ts";

export const SERVER_NAME = "wattpad-archiver";

/** Largest run a single call may start; a full library is tens of thousands of requests. */
export const DEFAULT_MAX_STORIES = 10;
export const MAX_STORIES_LIMIT = 500;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
const MAX_REPORTED_FAILURES = 20;

class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", {
  message: Schema.String,
}) {}

const failure = (error: { readonly message: string }) =>
  new ToolFailure({ message: error.message });

export const LibraryTool = Tool.make("wattpad_library", {
  description:
    "List stories in the Wattpad library and whether each is archived. state: new, stale (changed on Wattpad), partial (chapters missing), archived. Read-only.",
  parameters: Schema.Struct({
    filter: Schema.optionalKey(Schema.Literals(["all", "pending"])),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIST_LIMIT })),
    ),
    offset: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
    ),
  }),
  success: Schema.Struct({
    total: Schema.Int,
    pending: Schema.Int,
    stories: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        parts: Schema.Int,
        state: Schema.Literals(["new", "stale", "partial", "archived"]),
      }),
    ),
    nextOffset: Schema.optionalKey(Schema.Int),
  }),
  failure: ToolFailure,
  failureMode: "return" as const,
})
  .annotate(Tool.Title, "List the Wattpad library")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ArchiveTool = Tool.make("wattpad_archive", {
  description: `Archive library stories as EPUBs into the server's output directory. Up-to-date stories are skipped. Give storyIds, or maxStories (default ${DEFAULT_MAX_STORIES}, max ${MAX_STORIES_LIMIT}); the full library is tens of thousands of requests, so run it in batches. force rebuilds archived stories.`,
  parameters: Schema.Struct({
    storyIds: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
    maxStories: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STORIES_LIMIT })),
    ),
    force: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    total: Schema.Int,
    archived: Schema.Int,
    skipped: Schema.Int,
    partial: Schema.Int,
    failedParts: Schema.Int,
    failedImages: Schema.Int,
    bytes: Schema.Int,
    failed: Schema.Array(
      Schema.Struct({ id: Schema.String, title: Schema.String, message: Schema.String }),
    ),
  }),
  failure: ToolFailure,
  failureMode: "return" as const,
})
  .annotate(Tool.Title, "Archive Wattpad stories as EPUBs")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const WattpadToolkit = Toolkit.make(LibraryTool, ArchiveTool);

export interface ToolSettings {
  readonly storyConcurrency: number;
  readonly chapterConcurrency: number;
}

/** Credentials, the output directory, and pacing come from the server's launch configuration, never from tool arguments. */
export const toolkitLayer = (settings: ToolSettings) =>
  WattpadToolkit.toLayer(
    Effect.gen(function* () {
      const archiver = yield* Archiver.Service;

      return {
        wattpad_library: Effect.fn("Mcp.library")(function* (input) {
          const status = yield* archiver.status.pipe(Effect.mapError(failure));
          const pending = status.filter((story) => story.state !== "archived");
          const rows = input.filter === "pending" ? pending : status;
          const offset = input.offset ?? 0;
          const limit = input.limit ?? DEFAULT_LIST_LIMIT;
          const page = rows.slice(offset, offset + limit);
          return {
            total: status.length,
            pending: pending.length,
            stories: page.map((story) => ({
              id: story.id,
              title: story.title,
              parts: story.numParts,
              state: story.state,
            })),
            ...(offset + limit < rows.length ? { nextOffset: offset + limit } : {}),
          };
        }),
        wattpad_archive: Effect.fn("Mcp.archive")(function* (input) {
          const summary = yield* archiver
            .archive({
              storyIds: input.storyIds,
              maxStories:
                input.storyIds === undefined
                  ? (input.maxStories ?? DEFAULT_MAX_STORIES)
                  : input.maxStories,
              force: input.force ?? false,
              storyConcurrency: settings.storyConcurrency,
              chapterConcurrency: settings.chapterConcurrency,
            })
            .pipe(Effect.mapError(failure));
          return { ...summary, failed: summary.failed.slice(0, MAX_REPORTED_FAILURES) };
        }),
      };
    }),
  );

export const serverLayer = (version: string, settings: ToolSettings) =>
  McpServer.toolkit(WattpadToolkit).pipe(
    Layer.provide(toolkitLayer(settings)),
    Layer.provideMerge(
      McpServer.layerStdio({
        name: SERVER_NAME,
        version,
        protocols: [McpProtocol.v2025_06_18],
      }),
    ),
    Layer.provide(NodeStdio.layer),
  );
