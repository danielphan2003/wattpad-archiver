import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { buildEpub, type EpubChapter, type EpubImage, imageExtension } from "./epub.ts";
import { ArchiveWriteError, type WattpadError } from "./errors.ts";
import { extractImageUrls, isWattpadImageUrl, toXhtml } from "./html.ts";
import * as Manifest from "./Manifest.ts";
import { isReadable, type LibraryStory, type Part, type Story } from "./wattpad/schema.ts";
import * as Wattpad from "./wattpad/Wattpad.ts";

export interface Options {
  /** Archive only these stories; everything in the library when omitted. */
  readonly storyIds?: ReadonlyArray<string> | undefined;
  /** Stop after this many stories that need archiving. */
  readonly maxStories?: number | undefined;
  /** Rebuild stories that are already up to date. */
  readonly force: boolean;
  readonly storyConcurrency: number;
  readonly chapterConcurrency: number;
}

export type Event = Data.TaggedEnum<{
  Planned: { readonly total: number; readonly pending: number; readonly skipped: number };
  StoryArchived: {
    readonly id: string;
    readonly title: string;
    readonly parts: number;
    readonly failedParts: number;
    readonly failedImages: number;
    readonly bytes: number;
  };
  StoryFailed: { readonly id: string; readonly title: string; readonly message: string };
}>;
export const Event = Data.taggedEnum<Event>();

export interface Summary {
  readonly total: number;
  readonly archived: number;
  readonly skipped: number;
  readonly failed: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly message: string;
  }>;
  /** Stories archived with at least one chapter missing; the next run retries them. */
  readonly partial: number;
  readonly failedParts: number;
  /** Images, covers included, that could not be downloaded. They are left out, not retried. */
  readonly failedImages: number;
  readonly bytes: number;
}

export type StoryState = "new" | "stale" | "partial" | "archived";

export interface LibraryStatus {
  readonly id: string;
  readonly title: string;
  readonly numParts: number;
  readonly modifyDate: string;
  readonly state: StoryState;
}

export interface Interface {
  readonly status: Effect.Effect<ReadonlyArray<LibraryStatus>, WattpadError>;
  readonly archive: (
    options: Options,
    onEvent?: (event: Event) => Effect.Effect<void>,
  ) => Effect.Effect<Summary, WattpadError | ArchiveWriteError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "wattpad-archiver/Archiver/Service",
) {}

export const stateOf = (story: LibraryStory, saved: Manifest.Entry | undefined): StoryState => {
  if (saved === undefined) return "new";
  if (saved.modifyDate !== story.modifyDate || saved.numParts !== story.numParts) return "stale";
  return saved.failedParts > 0 ? "partial" : "archived";
};

const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/gu;
/** A file name is at most 255 bytes. 150 for the title leaves room for ` [<id>].epub` and a temporary suffix. */
const MAX_TITLE_BYTES = 150;

const truncateToBytes = (text: string, limit: number) => {
  const encoder = new TextEncoder();
  let kept = "";
  let size = 0;
  for (const character of text) {
    size += encoder.encode(character).length;
    if (size > limit) break;
    kept += character;
  }
  return kept;
};

/** `<title> [<id>].epub`: readable, and unique across stories that share a title. Ids are digits, so the name has no separators. */
export const fileNameFor = (story: { readonly id: string; readonly title: string }) => {
  const cleaned = story.title
    .normalize("NFC")
    .replace(UNSAFE_FILENAME_CHARS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const title = truncateToBytes(cleaned, MAX_TITLE_BYTES).trim();
  return `${title.length === 0 ? "Untitled" : title} [${story.id}].epub`;
};

const IMAGE_CONCURRENCY = 6;

interface Candidate {
  readonly entry: LibraryStory;
  /** Present when the story was already fetched while planning. */
  readonly story: Story | undefined;
}

type StoryResult = Extract<Event, { readonly _tag: "StoryArchived" | "StoryFailed" }>;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const wattpad = yield* Wattpad.Service;
    const manifest = yield* Manifest.Service;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    /** The whole library from its listing, or just the named stories fetched directly, which skips the listing's page-by-page walk. */
    const candidates = Effect.fn("Archiver.candidates")(function* (
      storyIds: ReadonlyArray<string> | undefined,
    ) {
      if (storyIds === undefined) {
        const library = yield* wattpad.library.pipe(Stream.runCollect);
        return library.map((entry): Candidate => ({ entry, story: undefined }));
      }
      return yield* Effect.forEach(
        [...new Set(storyIds)],
        (id) =>
          wattpad.story(id).pipe(
            Effect.map((story): Candidate => ({
              entry: {
                id: story.id,
                title: story.title,
                modifyDate: story.modifyDate,
                numParts: story.numParts,
              },
              story,
            })),
          ),
        { concurrency: 4 },
      );
    });

    const status = Effect.fn("Archiver.status")(function* () {
      const library = yield* wattpad.library.pipe(Stream.runCollect);
      const saved = yield* manifest.entries;
      return library.map((story): LibraryStatus => ({
        id: story.id,
        title: story.title,
        numParts: story.numParts,
        modifyDate: story.modifyDate,
        state: stateOf(story, saved.get(story.id)),
      }));
    });

    /** A chapter or image that Wattpad refuses is a gap in the book; a rejected token ends the run. */
    const orMissing = <A, R>(effect: Effect.Effect<A, WattpadError, R>) =>
      effect.pipe(
        Effect.asSome,
        Effect.catchTags({
          WattpadNotFoundError: () => Effect.succeed(Option.none<A>()),
          WattpadRequestError: () => Effect.succeed(Option.none<A>()),
          WattpadResponseError: () => Effect.succeed(Option.none<A>()),
        }),
      );

    const loadChapters = (parts: ReadonlyArray<Part>, concurrency: number) =>
      Effect.forEach(parts, (part) => orMissing(wattpad.chapter(part)), { concurrency });

    const loadImages = Effect.fn("Archiver.loadImages")(function* (urls: ReadonlyArray<string>) {
      const downloaded = yield* Effect.forEach(
        urls,
        (url) =>
          orMissing(wattpad.image(url)).pipe(
            Effect.map(Option.map((image) => [url, image] as const)),
          ),
        { concurrency: IMAGE_CONCURRENCY },
      );
      const byUrl = new Map<string, EpubImage>();
      for (const found of downloaded) {
        if (Option.isNone(found)) continue;
        const [url, image] = found.value;
        const extension = imageExtension(image.mediaType);
        if (extension === undefined) continue;
        byUrl.set(url, {
          path: `images/img-${byUrl.size + 1}.${extension}`,
          mediaType: image.mediaType,
          bytes: image.bytes,
        });
      }
      return byUrl;
    });

    const writeAtomically = Effect.fn("Archiver.writeAtomically")(function* (
      target: string,
      bytes: Uint8Array,
    ) {
      // A name no other run shares, so two processes archiving one story cannot trample a temporary file.
      const partial = `${target}.${(yield* Random.nextInt).toString(36)}.part`;
      yield* fileSystem.writeFile(partial, bytes).pipe(
        Effect.andThen(fileSystem.rename(partial, target)),
        Effect.onError(() => fileSystem.remove(partial, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(
          (cause) => new ArchiveWriteError({ operation: "write", path: target, cause }),
        ),
      );
    });

    const archiveStory = Effect.fn("Archiver.archiveStory")(function* (
      candidate: Candidate,
      chapterConcurrency: number,
    ) {
      const { entry } = candidate;
      const story = candidate.story ?? (yield* wattpad.story(entry.id));
      const parts = story.parts.filter(isReadable);

      const [texts, cover] = yield* Effect.all(
        [
          loadChapters(parts, chapterConcurrency),
          isWattpadImageUrl(story.cover)
            ? orMissing(wattpad.image(story.cover))
            : Effect.succeed(Option.none<Wattpad.Image>()),
        ],
        { concurrency: 2 },
      );

      const imageUrls = new Set<string>();
      for (const [index, text] of texts.entries()) {
        for (const url of Option.isSome(text) ? extractImageUrls(text.value) : [])
          imageUrls.add(url);
        const photo = parts[index]?.photoUrl;
        if (photo !== undefined && isWattpadImageUrl(photo)) imageUrls.add(photo);
      }
      const images = yield* loadImages([...imageUrls]);
      const sources = new Map([...images].map(([url, image]) => [url, image.path] as const));

      const chapters = parts.map((part, index): EpubChapter => {
        const text = texts[index];
        const photo = part.photoUrl === undefined ? undefined : sources.get(part.photoUrl);
        return {
          part,
          body:
            text !== undefined && Option.isSome(text) ? toXhtml(text.value, sources) : undefined,
          photoPath: photo,
        };
      });
      // A story that lists more chapters than it returned is incomplete, not finished.
      const missingParts = Math.max(0, story.numParts - story.parts.length);
      const failedParts =
        chapters.filter((chapter) => chapter.body === undefined).length + missingParts;
      const coverExtension = Option.isSome(cover)
        ? imageExtension(cover.value.mediaType)
        : undefined;
      const coverMissing = isWattpadImageUrl(story.cover) && coverExtension === undefined;
      const failedImages = imageUrls.size - images.size + (coverMissing ? 1 : 0);
      const bytes = buildEpub({
        story,
        chapters,
        cover:
          Option.isSome(cover) && coverExtension !== undefined
            ? { path: `images/cover.${coverExtension}`, ...cover.value }
            : undefined,
        images: [...images.values()],
      });

      const file = fileNameFor(story);
      yield* writeAtomically(path.join(manifest.outputDir, file), bytes);

      const previous = (yield* manifest.entries).get(entry.id);
      if (previous !== undefined && previous.file !== file) {
        yield* fileSystem
          .remove(path.join(manifest.outputDir, previous.file), { force: true })
          .pipe(Effect.ignore);
      }
      yield* manifest.record({
        id: entry.id,
        modifyDate: entry.modifyDate,
        numParts: entry.numParts,
        file,
        bytes: bytes.length,
        failedParts,
        archivedAt: DateTime.formatIso(yield* DateTime.now),
      });
      return { parts: parts.length, failedParts, failedImages, bytes: bytes.length };
    });

    const archive = Effect.fn("Archiver.archive")(function* (
      options: Options,
      onEvent: (event: Event) => Effect.Effect<void> = () => Effect.void,
    ) {
      const library = yield* candidates(options.storyIds);
      const saved = yield* manifest.entries;

      const needsArchive = yield* Effect.forEach(
        library,
        ({ entry: story }) => {
          const previous = saved.get(story.id);
          if (options.force || stateOf(story, previous) !== "archived" || previous === undefined) {
            return Effect.succeed(true);
          }
          return fileSystem.exists(path.join(manifest.outputDir, previous.file)).pipe(
            Effect.map((exists) => !exists),
            Effect.orElseSucceed(() => true),
          );
        },
        { concurrency: 16 },
      );
      const due = library.filter((_, index) => needsArchive[index] === true);
      const pending = options.maxStories === undefined ? due : due.slice(0, options.maxStories);
      yield* onEvent(
        Event.Planned({
          total: library.length,
          pending: pending.length,
          skipped: library.length - due.length,
        }),
      );

      const results = yield* Effect.forEach(
        pending,
        (candidate) =>
          archiveStory(candidate, options.chapterConcurrency).pipe(
            Effect.map((result): StoryResult =>
              Event.StoryArchived({
                id: candidate.entry.id,
                title: candidate.entry.title,
                ...result,
              }),
            ),
            // A rejected token fails every later request too, so it stops the run; other failures skip one story.
            Effect.catchTags({
              WattpadNotFoundError: (error) =>
                Effect.succeed(failure(candidate.entry, error.message)),
              WattpadRequestError: (error) =>
                Effect.succeed(failure(candidate.entry, error.message)),
              WattpadResponseError: (error) =>
                Effect.succeed(failure(candidate.entry, error.message)),
              ArchiveWriteError: (error) => Effect.succeed(failure(candidate.entry, error.message)),
            }),
            Effect.tap((result) => onEvent(result)),
          ),
        { concurrency: options.storyConcurrency },
      );

      const archived = results.filter((result) => result._tag === "StoryArchived");
      return {
        total: library.length,
        archived: archived.length,
        skipped: library.length - due.length,
        failed: results
          .filter((result) => result._tag === "StoryFailed")
          .map(({ id, title, message }) => ({ id, title, message })),
        partial: archived.filter((result) => result.failedParts > 0).length,
        failedParts: archived.reduce((sum, result) => sum + result.failedParts, 0),
        failedImages: archived.reduce((sum, result) => sum + result.failedImages, 0),
        bytes: archived.reduce((sum, result) => sum + result.bytes, 0),
      } satisfies Summary;
    });

    // One run at a time: two overlapping runs would rebuild the same stories and double the load on Wattpad.
    const runLock = yield* Semaphore.make(1);

    return Service.of({
      status: status(),
      archive: Effect.fn("Archiver.archiveExclusive")(function* (options, onEvent) {
        return yield* runLock.withPermits(1)(archive(options, onEvent));
      }),
    });
  }),
);

const failure = (entry: LibraryStory, message: string): StoryResult =>
  Event.StoryFailed({ id: entry.id, title: entry.title, message });
