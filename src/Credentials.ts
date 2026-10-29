import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";

import { CredentialsError } from "./errors.ts";

export interface Interface {
  readonly username: string;
  readonly token: Redacted.Redacted;
}

export class Service extends Context.Service<Service, Interface>()(
  "wattpad-archiver/Credentials/Service",
) {}

export interface Overrides {
  readonly username?: string | undefined;
  readonly tokenFile?: string | undefined;
}

const readTokenFile = Effect.fn("Credentials.readTokenFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const content = yield* fileSystem
    .readFileString(path)
    .pipe(
      Effect.mapError(
        () => new CredentialsError({ reason: `Could not read the token file ${path}.` }),
      ),
    );
  return content.trim();
});

const CONFIG_DIRECTORY_NAME = "wattpad-archiver";
const USERNAME_FILE = "username";
const TOKEN_FILE = "token";

/** `$XDG_CONFIG_HOME/wattpad-archiver`, else `~/.config/wattpad-archiver`. */
export const configDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const xdg = yield* Config.option(Config.String("XDG_CONFIG_HOME"));
  if (Option.isSome(xdg) && path.isAbsolute(xdg.value)) {
    return path.join(xdg.value, CONFIG_DIRECTORY_NAME);
  }
  const home = yield* Config.option(Config.String("HOME"));
  if (Option.isNone(home) || !path.isAbsolute(home.value)) {
    return yield* new CredentialsError({
      reason: "Cannot find the config directory: set XDG_CONFIG_HOME or HOME.",
    });
  }
  return path.join(home.value, ".config", CONFIG_DIRECTORY_NAME);
});

const readStored = Effect.fn("Credentials.readStored")(function* (name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* configDirectory.pipe(Effect.option);
  if (Option.isNone(directory)) return undefined;
  const file = path.join(directory.value, name);
  const info = yield* fileSystem.stat(file).pipe(Effect.option);
  if (Option.isNone(info)) return undefined;
  // Like ssh with a private key: refuse a token other accounts can read.
  if (name === TOKEN_FILE && (info.value.mode & 0o077) !== 0) {
    return yield* new CredentialsError({
      reason: `${file} is readable by other accounts. Run chmod 600 on it.`,
    });
  }
  const content = yield* fileSystem
    .readFileString(file)
    .pipe(Effect.mapError(() => new CredentialsError({ reason: `Could not read ${file}.` })));
  const value = content.trim();
  return value.length === 0 ? undefined : value;
});

/**
 * Flags win over `WATTPAD_USERNAME`, `WATTPAD_TOKEN`, and `WATTPAD_TOKEN_FILE`, and those win over the
 * `username` and `token` files in the config directory.
 * The token never travels as a flag or a tool argument, so it stays out of shell history and process lists.
 */
export const layer = (overrides: Overrides = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const username =
        overrides.username ??
        (yield* Config.option(Config.String("WATTPAD_USERNAME")).pipe(
          Effect.map(Option.getOrUndefined),
        )) ??
        (yield* readStored(USERNAME_FILE));
      if (username === undefined || username.length === 0) {
        return yield* new CredentialsError({
          reason:
            "Set --username or WATTPAD_USERNAME, or run `wattpad-archiver login`, to name the Wattpad account to archive.",
        });
      }

      const tokenFile =
        overrides.tokenFile ??
        (yield* Config.option(Config.String("WATTPAD_TOKEN_FILE")).pipe(
          Effect.map(Option.getOrUndefined),
        ));
      const token =
        tokenFile !== undefined
          ? yield* readTokenFile(tokenFile)
          : ((yield* Config.option(Config.Redacted("WATTPAD_TOKEN")).pipe(
              Effect.map(Option.map(Redacted.value)),
              Effect.map(Option.getOrUndefined),
            )) ?? (yield* readStored(TOKEN_FILE)));
      if (token === undefined || token.length === 0) {
        return yield* new CredentialsError({
          reason:
            "Set --token-file, WATTPAD_TOKEN_FILE, or WATTPAD_TOKEN, or run `wattpad-archiver login`, with the `token` cookie of a logged-in Wattpad session.",
        });
      }

      return Service.of({ username, token: Redacted.make(token) });
    }),
  );

const writePrivate = Effect.fn("Credentials.writePrivate")(function* (
  directory: string,
  name: string,
  content: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const suffix = yield* Random.nextInt;
  const temporary = path.join(directory, `.${name}.${suffix.toString(36)}.tmp`);
  yield* fileSystem.writeFileString(temporary, `${content}\n`, { mode: 0o600, flag: "wx" });
  yield* fileSystem
    .rename(temporary, path.join(directory, name))
    .pipe(Effect.tapError(() => fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)));
});

/** Saves the account and token to the config directory, readable by this account only. Returns the directory. */
export const store = Effect.fn("Credentials.store")(function* (input: {
  readonly username: string;
  readonly token: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* configDirectory;
  const username = input.username.trim();
  const token = input.token.trim();
  if (username.length === 0 || token.length === 0) {
    return yield* new CredentialsError({ reason: "The account and the token must not be empty." });
  }
  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* writePrivate(directory, TOKEN_FILE, token);
    yield* writePrivate(directory, USERNAME_FILE, username);
  }).pipe(
    Effect.mapError(() => new CredentialsError({ reason: `Could not write to ${directory}.` })),
  );
  return directory;
});
