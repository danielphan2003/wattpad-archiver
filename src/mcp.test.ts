import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as Archiver from "./Archiver.ts";
import * as Mcp from "./mcp.ts";

const SETTINGS = { storyConcurrency: 3, chapterConcurrency: 5 };

const summary: Archiver.Summary = {
  total: 0,
  archived: 0,
  skipped: 0,
  failed: [],
  partial: 0,
  failedParts: 0,
  bytes: 0,
};

const statuses = (count: number): ReadonlyArray<Archiver.LibraryStatus> =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index),
    title: `Story ${index}`,
    numParts: 1,
    modifyDate: "2026-01-01T00:00:00Z",
    state: index % 2 === 0 ? "archived" : "new",
  }));

/** An archiver that records the options each archive call received. */
const fakeArchiver = (library: ReadonlyArray<Archiver.LibraryStatus> = []) => {
  const received: Array<Archiver.Options> = [];
  const layer = Layer.succeed(
    Archiver.Service,
    Archiver.Service.of({
      status: Effect.succeed(library),
      archive: (options) => {
        received.push(options);
        return Effect.succeed(summary);
      },
    }),
  );
  return { received, layer };
};

/** A handler streams preliminary results; the last element is the answer, as the client receives it. */
const answer = <A, E, E2, R, R2>(call: Effect.Effect<Stream.Stream<A, E, R>, E2, R2>) =>
  call.pipe(
    Effect.flatMap(Stream.runLast),
    Effect.flatMap((last) => Effect.fromOption(last)),
  );

const call = (fake: ReturnType<typeof fakeArchiver>) =>
  Effect.gen(function* () {
    const tools = yield* Mcp.WattpadToolkit;
    return {
      library: (params: { filter?: "all" | "pending"; limit?: number; offset?: number }) =>
        answer(tools.handle("wattpad_library", params)),
      archive: (params: {
        storyIds?: ReadonlyArray<string>;
        maxStories?: number;
        force?: boolean;
      }) => answer(tools.handle("wattpad_archive", params)),
    };
  }).pipe(Effect.provide(Mcp.toolkitLayer(SETTINGS).pipe(Layer.provide(fake.layer))));

describe("MCP tools", () => {
  it.effect("bounds an archive call that names no stories, and passes the server's pacing", () => {
    const fake = fakeArchiver();
    return Effect.gen(function* () {
      const tools = yield* call(fake);
      yield* tools.archive({});
      yield* tools.archive({ maxStories: 40, force: true });
      yield* tools.archive({ storyIds: ["7", "8"] });

      expect(fake.received.map((options) => options.maxStories)).toEqual([
        Mcp.DEFAULT_MAX_STORIES,
        40,
        undefined,
      ]);
      expect(fake.received.map((options) => options.force)).toEqual([false, true, false]);
      expect(fake.received.every((options) => options.storyConcurrency === 3)).toBe(true);
      expect(fake.received.every((options) => options.chapterConcurrency === 5)).toBe(true);
    });
  });

  it.effect("pages the library and filters to what still needs archiving", () => {
    const fake = fakeArchiver(statuses(7));
    return Effect.gen(function* () {
      const tools = yield* call(fake);

      const firstPage = (yield* tools.library({ limit: 3 })).encodedResult;
      expect(firstPage).toMatchObject({
        total: 7,
        pending: 3,
        nextOffset: 3,
        stories: [{ id: "0" }, { id: "1" }, { id: "2" }],
      });

      const pending = (yield* tools.library({ filter: "pending" })).encodedResult;
      expect(pending).toMatchObject({
        stories: [{ state: "new" }, { state: "new" }, { state: "new" }],
      });
      expect(pending).not.toHaveProperty("nextOffset");
    });
  });

  it("keeps the advertised tool descriptions and schemas small enough for an agent's context", () => {
    const advertised = Object.values(Mcp.WattpadToolkit.tools).map((tool) => ({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
    }));
    expect(advertised.map((tool) => tool.name)).toEqual(["wattpad_library", "wattpad_archive"]);
    expect(JSON.stringify(advertised).length).toBeLessThan(1_100);
  });
});
