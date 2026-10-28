import * as Layer from "effect/Layer";

import * as Archiver from "./Archiver.ts";
import * as Credentials from "./Credentials.ts";
import * as Http from "./http.ts";
import * as Manifest from "./Manifest.ts";
import * as Wattpad from "./wattpad/Wattpad.ts";

export interface RuntimeOptions {
  readonly username?: string | undefined;
  readonly tokenFile?: string | undefined;
  readonly outputDir: string;
  readonly requestsPerSecond: number;
  readonly retries: number;
}

/** The archiver with its HTTP client, state log, and credentials; needs `FileSystem` and `Path`. */
export const layer = (options: RuntimeOptions) =>
  Archiver.layer.pipe(
    Layer.provideMerge(Wattpad.layer),
    Layer.provideMerge(Manifest.layer(options.outputDir)),
    Layer.provideMerge(
      Http.layer({ requestsPerSecond: options.requestsPerSecond, maxRetries: options.retries }),
    ),
    Layer.provideMerge(
      Credentials.layer({ username: options.username, tokenFile: options.tokenFile }),
    ),
  );
