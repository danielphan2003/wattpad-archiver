import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

/**
 * Flags win over `WATTPAD_USERNAME`, `WATTPAD_TOKEN`, and `WATTPAD_TOKEN_FILE`.
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
        ));
      if (username === undefined || username.length === 0) {
        return yield* new CredentialsError({
          reason: "Set --username or WATTPAD_USERNAME to the Wattpad account to archive.",
        });
      }

      const tokenFile =
        overrides.tokenFile ??
        (yield* Config.option(Config.String("WATTPAD_TOKEN_FILE")).pipe(
          Effect.map(Option.getOrUndefined),
        ));
      const token =
        tokenFile === undefined
          ? yield* Config.option(Config.Redacted("WATTPAD_TOKEN")).pipe(
              Effect.map(Option.map(Redacted.value)),
              Effect.map(Option.getOrUndefined),
            )
          : yield* readTokenFile(tokenFile);
      if (token === undefined || token.length === 0) {
        return yield* new CredentialsError({
          reason:
            "Set --token-file, WATTPAD_TOKEN_FILE, or WATTPAD_TOKEN to the `token` cookie of a logged-in Wattpad session.",
        });
      }

      return Service.of({ username, token: Redacted.make(token) });
    }),
  );
