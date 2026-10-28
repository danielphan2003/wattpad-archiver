import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { strFromU8, unzipSync } from "fflate";

import * as Archiver from "./Archiver.ts";
import { WattpadAuthError, WattpadNotFoundError, WattpadRequestError } from "./errors.ts";
import { makePart, makeStory } from "./fixtures.testkit.ts";
import * as Manifest from "./Manifest.ts";
import type { Story } from "./wattpad/schema.ts";
import * as Wattpad from "./wattpad/Wattpad.ts";

const IMAGE_URL = "https://img.wattpad.com/inline.png";

/** A Wattpad whose library, failures, and call counts the test controls. */
const makeFake = (...initial: ReadonlyArray<Story>) => {
  const stories = new Map(initial.map((story) => [story.id, story] as const));
  const failChapters = new Set<number>();
  const failStories = new Map<string, WattpadAuthError | WattpadNotFoundError>();
  const calls = { library: 0, story: 0, chapter: 0 };

  const layer = Layer.succeed(
    Wattpad.Service,
    Wattpad.Service.of({
      library: Stream.suspend(() => {
        calls.library += 1;
        return Stream.fromIterable(
          [...stories.values()].map(({ id, title, modifyDate, numParts }) => ({
            id,
            title,
            modifyDate,
            numParts,
          })),
        );
      }),
      story: Effect.fn("fake.story")(function* (id: string) {
        calls.story += 1;
        const failure = failStories.get(id);
        if (failure !== undefined) return yield* failure;
        const story = stories.get(id);
        return (
          story ?? (yield* new WattpadNotFoundError({ operation: "story", target: `story ${id}` }))
        );
      }),
      chapter: Effect.fn("fake.chapter")(function* (part) {
        calls.chapter += 1;
        if (failChapters.has(part.id)) {
          return yield* new WattpadRequestError({ operation: "chapter", status: 500 });
        }
        return `<p>chapter ${part.id}</p><img src="${IMAGE_URL}">`;
      }),
      image: () =>
        Effect.succeed({ bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" }),
    }),
  );
  return { stories, failChapters, failStories, calls, layer };
};

const OPTIONS: Archiver.Options = { force: false, storyConcurrency: 2, chapterConcurrency: 2 };

/** Runs `body` against a fresh output directory with `fake` behind the archiver. */
const inArchive = <A, E>(
  fake: ReturnType<typeof makeFake>,
  body: (
    directory: string,
  ) => Effect.Effect<A, E, Archiver.Service | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    return yield* body(directory).pipe(
      Effect.provide(
        Archiver.layer.pipe(Layer.provide(fake.layer), Layer.provide(Manifest.layer(directory))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const archive = (options: Partial<Archiver.Options> = {}) =>
  Archiver.Service.pipe(Effect.flatMap((archiver) => archiver.archive({ ...OPTIONS, ...options })));

describe("Archiver", () => {
  it.effect("archives a story with its images, then skips it until it changes", () => {
    const fake = makeFake(makeStory("1"));
    return inArchive(fake, (directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const first = yield* archive();
        expect(first).toMatchObject({ total: 1, archived: 1, skipped: 0, partial: 0 });

        const book = unzipSync(
          yield* fileSystem.readFile(path.join(directory, "Story 1 [1].epub")),
        );
        expect(Object.keys(book)).toContain("OEBPS/images/img-1.png");
        expect(strFromU8(book["OEBPS/chapter-11.xhtml"]!)).toContain('src="images/img-1.png"');

        const requestsAfterFirstRun = { ...fake.calls };
        const second = yield* archive();
        expect(second).toMatchObject({ archived: 0, skipped: 1 });
        expect(fake.calls.story).toBe(requestsAfterFirstRun.story);
        expect(fake.calls.chapter).toBe(requestsAfterFirstRun.chapter);

        fake.stories.set("1", makeStory("1", { modifyDate: "2026-02-01T00:00:00Z" }));
        expect(yield* archive()).toMatchObject({ archived: 1, skipped: 0 });
        expect(yield* archive({ force: true })).toMatchObject({ archived: 1 });
      }),
    );
  });

  it.effect(
    "rebuilds a deleted file and renames a retitled story without leaving the old file",
    () => {
      const fake = makeFake(makeStory("1"));
      return inArchive(fake, (directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* archive();

          yield* fileSystem.remove(path.join(directory, "Story 1 [1].epub"));
          expect(yield* archive()).toMatchObject({ archived: 1 });

          fake.stories.set(
            "1",
            makeStory("1", { title: "New: Title?", modifyDate: "2026-03-01T00:00:00Z" }),
          );
          yield* archive();
          const files = (yield* fileSystem.readDirectory(directory)).filter((name) =>
            name.endsWith(".epub"),
          );
          expect(files).toEqual(["New Title [1].epub"]);
        }),
      );
    },
  );

  it.effect("retries a story with missing chapters until every chapter downloads", () => {
    const fake = makeFake(makeStory("1"));
    fake.failChapters.add(12);
    return inArchive(fake, () =>
      Effect.gen(function* () {
        expect(yield* archive()).toMatchObject({ archived: 1, partial: 1, failedParts: 1 });
        const status = yield* Archiver.Service.pipe(Effect.flatMap((archiver) => archiver.status));
        expect(status.map((story) => story.state)).toEqual(["partial"]);

        fake.failChapters.clear();
        expect(yield* archive()).toMatchObject({ archived: 1, partial: 0, failedParts: 0 });
        expect(yield* archive()).toMatchObject({ archived: 0, skipped: 1 });
      }),
    );
  });

  it.effect("skips drafts and deleted chapters", () => {
    const fake = makeFake(
      makeStory("1", {
        parts: [makePart(11), makePart(12, { draft: true }), makePart(13, { deleted: true })],
      }),
    );
    return inArchive(fake, () =>
      Effect.gen(function* () {
        yield* archive();
        expect(fake.calls.chapter).toBe(1);
      }),
    );
  });

  it.effect("reports a failed story and keeps going, but stops when the token is rejected", () => {
    const fake = makeFake(makeStory("1"), makeStory("2"));
    fake.failStories.set("1", new WattpadNotFoundError({ operation: "story", target: "story 1" }));
    return inArchive(fake, () =>
      Effect.gen(function* () {
        const summary = yield* archive();
        expect(summary.archived).toBe(1);
        expect(summary.failed).toHaveLength(1);
        expect(summary.failed[0]).toMatchObject({ id: "1", message: "Wattpad has no story 1." });

        fake.failStories.set("2", new WattpadAuthError({ operation: "story" }));
        const error = yield* archive({ force: true }).pipe(Effect.flip);
        expect(error._tag).toBe("WattpadAuthError");
      }),
    );
  });

  it.effect("fetches named stories directly and bounds a batch with maxStories", () => {
    const fake = makeFake(makeStory("1"), makeStory("2"), makeStory("3"));
    return inArchive(fake, () =>
      Effect.gen(function* () {
        expect(yield* archive({ storyIds: ["2"] })).toMatchObject({ total: 1, archived: 1 });
        expect(fake.calls.library).toBe(0);
        expect(fake.calls.story).toBe(1);

        const batch = yield* archive({ maxStories: 1 });
        expect(batch).toMatchObject({ total: 3, archived: 1, skipped: 1 });
        const rest = yield* archive();
        expect(rest).toMatchObject({ archived: 1, skipped: 2 });
      }),
    );
  });
});
