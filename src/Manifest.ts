import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ArchiveWriteError } from "./errors.ts";

export const Entry = Schema.Struct({
  id: Schema.String,
  modifyDate: Schema.String,
  numParts: Schema.Int,
  /** File name inside the output directory. */
  file: Schema.String,
  bytes: Schema.Int,
  /** Chapters that could not be downloaded; the story is retried on the next run while this is above zero. */
  failedParts: Schema.Int,
  archivedAt: Schema.String,
});
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Entry));
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Entry));

export interface Interface {
  readonly outputDir: string;
  readonly entries: Effect.Effect<ReadonlyMap<string, Entry>>;
  readonly record: (entry: Entry) => Effect.Effect<void, ArchiveWriteError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "wattpad-archiver/Manifest/Service",
) {}

/**
 * What has been archived is an append-only log beside the EPUBs, last line per story wins.
 * Appending one line per story costs the same at 6 stories or 6,000, and a crash mid-write
 * damages only the last line, which loading skips.
 */
export const layer = (outputDir: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(outputDir, ".wattpad-archiver");
      const logPath = path.join(directory, "state.jsonl");
      const writeError = (operation: string) => (cause: unknown) =>
        new ArchiveWriteError({ operation, path: logPath, cause });

      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError(writeError("create")));

      const existing = yield* fileSystem.exists(logPath).pipe(Effect.mapError(writeError("read")));
      const loaded = new Map<string, Entry>();
      if (existing) {
        const text = yield* fileSystem
          .readFileString(logPath)
          .pipe(Effect.mapError(writeError("read")));
        for (const line of text.split("\n")) {
          const entry = Option.getOrUndefined(decodeLine(line));
          if (entry !== undefined) loaded.set(entry.id, entry);
        }
      }

      const lock = yield* Semaphore.make(1);
      const record = Effect.fn("Manifest.record")(function* (entry: Entry) {
        yield* lock.withPermits(1)(
          fileSystem.writeFileString(logPath, `${encodeLine(entry)}\n`, { flag: "a" }).pipe(
            Effect.mapError(writeError("append to")),
            Effect.tap(() => Effect.sync(() => loaded.set(entry.id, entry))),
          ),
        );
      });

      return Service.of({
        outputDir,
        entries: Effect.sync(() => new Map(loaded)),
        record,
      });
    }),
  );
