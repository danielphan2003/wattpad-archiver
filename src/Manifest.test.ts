import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Manifest from "./Manifest.ts";

const entry = (id: string, overrides: Partial<Manifest.Entry> = {}): Manifest.Entry => ({
  id,
  modifyDate: "2026-01-01T00:00:00Z",
  numParts: 3,
  file: `${id}.epub`,
  bytes: 100,
  failedParts: 0,
  archivedAt: "2026-01-02T00:00:00Z",
  ...overrides,
});

const load = (directory: string) =>
  Effect.gen(function* () {
    return yield* (yield* Manifest.Service).entries;
  }).pipe(Effect.provide(Manifest.layer(directory)));

describe("Manifest", () => {
  it.effect("keeps the last record per story across restarts", () =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        const manifest = yield* Manifest.Service;
        yield* manifest.record(entry("1", { numParts: 3 }));
        yield* manifest.record(entry("2"));
        yield* manifest.record(entry("1", { numParts: 4, failedParts: 1 }));
        expect((yield* manifest.entries).size).toBe(2);
      }).pipe(Effect.provide(Manifest.layer(directory)));

      const entries = yield* load(directory);
      expect(entries.get("1")).toMatchObject({ numParts: 4, failedParts: 1 });
      expect(entries.get("2")?.file).toBe("2.epub");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips a line cut short by a crash and keeps the records around it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        const manifest = yield* Manifest.Service;
        yield* manifest.record(entry("1"));
      }).pipe(Effect.provide(Manifest.layer(directory)));

      const log = path.join(directory, ".wattpad-archiver", "state.jsonl");
      yield* fileSystem.writeFileString(log, '{"id":"2","modifyDa', { flag: "a" });
      yield* fileSystem.writeFileString(log, "\n", { flag: "a" });

      expect([...(yield* load(directory)).keys()]).toEqual(["1"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
