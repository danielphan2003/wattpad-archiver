import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import * as Credentials from "./Credentials.ts";

const withEnv = (env: Record<string, string>) =>
  Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromUnknown(env)));

const resolve = (overrides: Credentials.Overrides) =>
  Credentials.Service.pipe(Effect.provide(Credentials.layer(overrides)));

describe("Credentials", () => {
  it.effect("prefers flags over the environment and reads the token from a file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const tokenFile = path.join(directory, "token");
      yield* fileSystem.writeFileString(tokenFile, "from-file\n");

      const credentials = yield* resolve({ username: "flag-user", tokenFile });

      expect(credentials.username).toBe("flag-user");
      expect(Redacted.value(credentials.token)).toBe("from-file");
      expect(String(credentials.token)).not.toContain("from-file");
    }).pipe(Effect.provide(withEnv({ WATTPAD_USERNAME: "env-user", WATTPAD_TOKEN: "from-env" }))),
  );

  it.effect("falls back to the environment", () =>
    Effect.gen(function* () {
      const credentials = yield* resolve({});
      expect(credentials.username).toBe("env-user");
      expect(Redacted.value(credentials.token)).toBe("from-env");
    }).pipe(Effect.provide(withEnv({ WATTPAD_USERNAME: "env-user", WATTPAD_TOKEN: "from-env" }))),
  );

  it.effect.each([
    { name: "the account", env: { WATTPAD_TOKEN: "t" }, mentions: "WATTPAD_USERNAME" },
    { name: "the token", env: { WATTPAD_USERNAME: "u" }, mentions: "--token-file" },
    {
      name: "an unreadable token file",
      env: { WATTPAD_USERNAME: "u", WATTPAD_TOKEN_FILE: "/definitely/not/here" },
      mentions: "/definitely/not/here",
    },
  ])("says what is missing when $name is not set", ({ env, mentions }) =>
    Effect.gen(function* () {
      const error = yield* resolve({}).pipe(Effect.flip);
      expect(error._tag).toBe("CredentialsError");
      expect(error.message).toContain(mentions);
    }).pipe(Effect.provide(withEnv(env))),
  );

  describe("config directory", () => {
    const withConfigHome = <A, E>(
      env: Record<string, string>,
      body: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
    ) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped();
        const directory = path.join(home, "wattpad-archiver");
        return yield* body(directory).pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: home, ...env })),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer));

    it.effect("stores private files that later runs read back", () =>
      withConfigHome({}, (directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const saved = yield* Credentials.store({ username: " me ", token: "secret-token\n" });
          expect(saved).toBe(directory);

          expect((yield* fileSystem.stat(directory)).mode & 0o077).toBe(0);
          expect((yield* fileSystem.stat(path.join(directory, "token"))).mode & 0o077).toBe(0);
          expect(yield* fileSystem.readDirectory(directory)).toEqual(["token", "username"]);

          const credentials = yield* resolve({});
          expect(credentials.username).toBe("me");
          expect(Redacted.value(credentials.token)).toBe("secret-token");
        }),
      ),
    );

    it.effect("lets flags and the environment win over stored values", () =>
      withConfigHome({ WATTPAD_USERNAME: "env-user", WATTPAD_TOKEN: "env-token" }, () =>
        Effect.gen(function* () {
          yield* Credentials.store({ username: "stored", token: "stored-token" });
          const credentials = yield* resolve({});
          expect(credentials.username).toBe("env-user");
          expect(Redacted.value(credentials.token)).toBe("env-token");
        }),
      ),
    );

    it.effect("refuses a token other accounts can read", () =>
      withConfigHome({}, (directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* Credentials.store({ username: "me", token: "secret-token" });
          yield* fileSystem.chmod(path.join(directory, "token"), 0o644);

          const error = yield* resolve({}).pipe(Effect.flip);
          expect(error.message).toContain("chmod 600");
          expect(error.message).not.toContain("secret-token");
        }),
      ),
    );

    it.effect("says how to log in when nothing is stored", () =>
      withConfigHome({}, () =>
        Effect.gen(function* () {
          const error = yield* resolve({}).pipe(Effect.flip);
          expect(error.message).toContain("wattpad-archiver login");
        }),
      ),
    );
  });
});
