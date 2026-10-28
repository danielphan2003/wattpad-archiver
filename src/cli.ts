import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as Archiver from "./Archiver.ts";
import { statusLine, summaryLines, toJson } from "./format.ts";
import { DEFAULT_REQUESTS_PER_SECOND } from "./http.ts";
import * as Mcp from "./mcp.ts";
import * as Runtime from "./runtime.ts";
import packageJson from "../package.json" with { type: "json" };

const userError = (error: { readonly message: string }) =>
  new CliError.UserError({ cause: error.message });

const sharedFlags = {
  username: Flag.String("username").pipe(
    Flag.withAlias("u"),
    Flag.withDescription("Wattpad account to archive. Falls back to WATTPAD_USERNAME."),
    Flag.optional,
  ),
  tokenFile: Flag.String("token-file").pipe(
    Flag.withDescription(
      "File holding the `token` cookie of a logged-in session. Falls back to WATTPAD_TOKEN_FILE, then WATTPAD_TOKEN.",
    ),
    Flag.optional,
  ),
  output: Flag.String("output").pipe(
    Flag.withAlias("o"),
    Flag.withDescription(
      "Directory for the EPUBs and their state log. Falls back to WATTPAD_OUTPUT.",
    ),
    Flag.withFallbackConfig(Config.String("WATTPAD_OUTPUT")),
    Flag.withDefault("./wattpad-archive"),
  ),
  rate: Flag.Int("rate").pipe(
    Flag.withDescription("Requests per second sent to Wattpad. Slows itself down on 429."),
    Flag.withDefault(DEFAULT_REQUESTS_PER_SECOND),
  ),
  retries: Flag.Int("retries").pipe(
    Flag.withDescription("Retries per request for timeouts, 429, and 5xx."),
    Flag.withDefault(5),
  ),
  storyConcurrency: Flag.Int("story-concurrency").pipe(
    Flag.withDescription("Stories built at the same time."),
    Flag.withDefault(4),
  ),
  chapterConcurrency: Flag.Int("chapter-concurrency").pipe(
    Flag.withDescription("Chapters fetched at the same time within one story."),
    Flag.withDefault(8),
  ),
};

type SharedFlags = {
  readonly [K in keyof typeof sharedFlags]: (typeof sharedFlags)[K] extends Flag.Flag<infer A>
    ? A
    : never;
};

const runtimeLayer = (flags: SharedFlags) =>
  Runtime.layer({
    username: flags.username._tag === "Some" ? flags.username.value : undefined,
    tokenFile: flags.tokenFile._tag === "Some" ? flags.tokenFile.value : undefined,
    outputDir: flags.output,
    requestsPerSecond: flags.rate,
    retries: flags.retries,
  });

const archiveCommand = Command.make("archive", {
  ...sharedFlags,
  story: Flag.String("story").pipe(
    Flag.withDescription("Archive only this story id. Repeat for several."),
    Flag.atLeast(0),
  ),
  maxStories: Flag.Int("max-stories").pipe(
    Flag.withDescription("Stop after this many stories that need archiving."),
    Flag.optional,
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription("Rebuild stories that are up to date."),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the summary as JSON."),
    Flag.withDefault(false),
  ),
  verbose: Flag.Boolean("verbose").pipe(
    Flag.withDescription("Print one line per story as it finishes."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Archive the library as EPUBs. Stories unchanged since the last run are skipped.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const archiver = yield* Archiver.Service;
      const summary = yield* archiver.archive(
        {
          storyIds: flags.story.length === 0 ? undefined : flags.story,
          maxStories: flags.maxStories._tag === "Some" ? flags.maxStories.value : undefined,
          force: flags.force,
          storyConcurrency: flags.storyConcurrency,
          chapterConcurrency: flags.chapterConcurrency,
        },
        (event) =>
          flags.verbose
            ? Archiver.Event.$match(event, {
                Planned: ({ pending, total }) =>
                  Console.error(`${pending} of ${total} stories to archive`),
                StoryArchived: ({ title, parts, failedParts }) =>
                  Console.error(
                    `archived ${title} (${parts} chapters${failedParts > 0 ? `, ${failedParts} missing` : ""})`,
                  ),
                StoryFailed: ({ title, message }) => Console.error(`failed ${title}: ${message}`),
              })
            : Effect.void,
      );
      const [headline = "", ...failures] = summaryLines(summary);
      yield* Console.log(flags.json ? toJson(summary) : headline);
      if (failures.length > 0) {
        return yield* new CliError.UserError({ cause: failures.join("\n") });
      }
    }).pipe(Effect.provide(runtimeLayer(flags)), Effect.mapError(userError)),
  ),
);

const listCommand = Command.make("list", {
  ...sharedFlags,
  pending: Flag.Boolean("pending").pipe(
    Flag.withDescription("Only stories that are new, changed, or missing chapters."),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the stories as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "List the library and whether each story is archived. Also checks the token.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const archiver = yield* Archiver.Service;
      const status = yield* archiver.status;
      const rows = flags.pending ? status.filter((story) => story.state !== "archived") : status;
      if (flags.json) {
        yield* Console.log(toJson(rows));
      } else {
        for (const story of rows) yield* Console.log(statusLine(story));
      }
    }).pipe(Effect.provide(runtimeLayer(flags)), Effect.mapError(userError)),
  ),
);

const mcpCommand = Command.make("mcp", sharedFlags).pipe(
  Command.withDescription(
    "Serve the archiver to an MCP client over stdio. The token, account, and output directory come from this command's flags and environment, not from tool calls.",
  ),
  Command.withHandler((flags) =>
    // stdout carries the protocol, so the default logger must not write to it.
    Layer.launch(
      Mcp.serverLayer(packageJson.version, {
        storyConcurrency: flags.storyConcurrency,
        chapterConcurrency: flags.chapterConcurrency,
      }).pipe(Layer.provide(runtimeLayer(flags)), Layer.provide(Logger.layer([]))),
    ).pipe(Effect.mapError(userError)),
  ),
);

export const cli = Command.make("wattpad-archiver").pipe(
  Command.withDescription("Archive a Wattpad library as EPUBs, from the command line or over MCP."),
  Command.withSubcommands([archiveCommand, listCommand, mcpCommand]),
);

export const runCli = () =>
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );
