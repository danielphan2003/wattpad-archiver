import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClientRequest, type HttpClientResponse } from "effect/http";

import * as Credentials from "../Credentials.ts";
import {
  WattpadAuthError,
  WattpadNotFoundError,
  WattpadRequestError,
  WattpadResponseError,
  type WattpadError,
} from "../errors.ts";
import * as Http from "../http.ts";
import { WATTPAD_HOST } from "../http.ts";
import {
  ApiFailure,
  LIBRARY_FIELDS,
  LibraryPage,
  type LibraryStory,
  type Part,
  STORY_FIELDS,
  Story,
} from "./schema.ts";
import { sniffImageType } from "./image.ts";
import { isWattpadHttpsUrl, isWattpadId } from "./urls.ts";

export interface Image {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface Interface {
  readonly library: Stream.Stream<LibraryStory, WattpadError>;
  readonly story: (id: string) => Effect.Effect<Story, WattpadError>;
  readonly chapter: (part: Part) => Effect.Effect<string, WattpadError>;
  readonly image: (url: string) => Effect.Effect<Image, WattpadError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "wattpad-archiver/wattpad/Wattpad/Service",
) {}

const API = `https://${WATTPAD_HOST}/api/v3`;
const decodeApiFailure = Schema.decodeUnknownOption(Schema.fromJsonString(ApiFailure));

/** One request, body included, must finish within this. */
const REQUEST_DEADLINE = "60 seconds";
const MAX_PAGES = 2_000;
const MiB = 1024 * 1024;
const LIMITS = { json: 16 * MiB, chapter: 8 * MiB, image: 25 * MiB, errorBody: MiB } as const;

/** Keeps a transport error's message and drops its payload, which holds the request and its cookie header. */
const describeCause = (cause: unknown) =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

const responseError = (operation: string) => (cause: unknown) =>
  new WattpadResponseError({ operation, cause: describeCause(cause) });

const classifyFailure = (operation: string, target: string, status: number, body: string) => {
  const failure = Option.getOrUndefined(decodeApiFailure(body));
  if (failure?.error_type === "PermissionDenied") return new WattpadAuthError({ operation });
  if (failure?.error_type === "NotFound") return new WattpadNotFoundError({ operation, target });
  return new WattpadRequestError({
    operation,
    status,
    ...(failure?.message === undefined ? {} : { detail: failure.message }),
  });
};

const isSuccess = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/** Reads a body, failing as soon as it passes `limit` rather than after buffering all of it. */
const readBody = (
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
) => {
  const tooLarge = new WattpadResponseError({
    operation,
    cause: `The response is larger than ${limit} bytes.`,
  });
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) return Effect.fail(tooLarge);
  return response.stream.pipe(
    Stream.mapAccumEffect(
      () => 0,
      (total, chunk) =>
        total + chunk.length > limit
          ? Effect.fail(tooLarge)
          : Effect.succeed([total + chunk.length, [chunk]] as const),
    ),
    Stream.runCollect,
    Effect.map(concat),
    Effect.mapError((error) => (error === tooLarge ? error : responseError(operation)(error))),
  );
};

const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* Http.Service;
    const { username } = yield* Credentials.Service;

    const send = (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      authenticated = false,
    ) =>
      (authenticated ? http.executeAuthenticated : http.execute)(request).pipe(
        Effect.mapError(responseError(operation)),
      );

    /** Applies the deadline to a whole request, body read included, so a stalled body cannot hang a run. */
    const withDeadline = <A, R>(operation: string, effect: Effect.Effect<A, WattpadError, R>) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: REQUEST_DEADLINE,
          orElse: () =>
            Effect.fail(new WattpadResponseError({ operation, cause: "The request timed out." })),
        }),
      );

    /** A success status is required: a redirect or an informational reply is not content. */
    const requireSuccess = Effect.fn("Wattpad.requireSuccess")(function* (
      operation: string,
      target: string,
      response: HttpClientResponse.HttpClientResponse,
    ) {
      if (isSuccess(response)) return;
      const body = yield* readBody(operation, response, LIMITS.errorBody).pipe(
        Effect.map(decodeText),
        Effect.orElseSucceed(() => ""),
      );
      return yield* classifyFailure(operation, target, response.status, body);
    });

    const getText = (
      operation: string,
      target: string,
      request: HttpClientRequest.HttpClientRequest,
      limit: number,
    ) =>
      withDeadline(
        operation,
        Effect.gen(function* () {
          const response = yield* send(operation, request);
          yield* requireSuccess(operation, target, response);
          return decodeText(yield* readBody(operation, response, limit));
        }),
      );

    const getJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
      operation: string,
      target: string,
      request: HttpClientRequest.HttpClientRequest,
      schema: S,
    ) =>
      getText(operation, target, request, LIMITS.json).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
        Effect.mapError((error) =>
          Schema.isSchemaError(error) ? responseError(operation)(error) : error,
        ),
      );

    const libraryPage = (url: string) =>
      isWattpadHttpsUrl(url)
        ? getJson("library", `library for ${username}`, HttpClientRequest.get(url), LibraryPage)
        : Effect.fail(
            new WattpadResponseError({
              operation: "library",
              cause: "The next page points outside wattpad.com.",
            }),
          );

    const firstPage = `${API}/users/${encodeURIComponent(username)}/library?${new URLSearchParams({
      fields: LIBRARY_FIELDS,
      limit: "100",
    })}`;

    /** Follows `nextUrl`, and stops with an error if a page repeats or the walk never ends. */
    const library = Stream.paginate({ url: firstPage, seen: new Set<string>() }, ({ url, seen }) =>
      seen.has(url) || seen.size >= MAX_PAGES
        ? Effect.fail(
            new WattpadResponseError({
              operation: "library",
              cause:
                "The library pagination did not end: a page repeated or the page limit was reached.",
            }),
          )
        : libraryPage(url).pipe(
            Effect.map(
              (page) =>
                [
                  page.stories,
                  Option.map(Option.fromNullishOr(page.nextUrl), (next) => ({
                    url: next,
                    seen: new Set(seen).add(url),
                  })),
                ] as const,
            ),
          ),
    );

    const story = Effect.fn("Wattpad.story")(function* (id: string) {
      if (!isWattpadId(id)) {
        return yield* new WattpadNotFoundError({ operation: "story", target: `story ${id}` });
      }
      const url = `${API}/stories/${id}?${new URLSearchParams({ fields: STORY_FIELDS })}`;
      return yield* getJson("story", `story ${id}`, HttpClientRequest.get(url), Story);
    });

    const chapter = Effect.fn("Wattpad.chapter")(function* (part: Part) {
      const url = part.text_url.text;
      if (!isWattpadHttpsUrl(url)) {
        return yield* new WattpadResponseError({
          operation: "chapter",
          cause: "The chapter URL is not an https wattpad.com URL.",
        });
      }
      const html = yield* getText(
        "chapter",
        `chapter ${part.id}`,
        HttpClientRequest.get(url),
        LIMITS.chapter,
      );
      // A chapter that cannot be served comes back as an API error body with a success status.
      const failure = Option.getOrUndefined(decodeApiFailure(html));
      if (failure !== undefined) {
        return yield* classifyFailure("chapter", `chapter ${part.id}`, 200, html);
      }
      return html;
    });

    const fetchImage = Effect.fn("Wattpad.fetchImage")(function* (url: string) {
      if (!isWattpadHttpsUrl(url)) {
        return yield* new WattpadResponseError({
          operation: "image",
          cause: "The image URL is not an https wattpad.com URL.",
        });
      }
      const bytes = yield* withDeadline(
        "image",
        Effect.gen(function* () {
          const request = HttpClientRequest.get(url);
          const open = yield* send("image", request);
          // Public images need no token. A host that wants one says so, and only then does it get the token.
          const response =
            open.status === 401 || open.status === 403 ? yield* send("image", request, true) : open;
          yield* requireSuccess("image", `image ${url}`, response);
          return yield* readBody("image", response, LIMITS.image);
        }),
      );
      // The bytes decide the type: a body labelled image/png that is really HTML is not an image.
      const mediaType = sniffImageType(bytes);
      if (mediaType === undefined) {
        return yield* new WattpadResponseError({
          operation: "image",
          cause: "The response is not a JPEG, PNG, GIF, or WebP image.",
        });
      }
      return { bytes, mediaType } satisfies Image;
    });

    // Concurrent chapters often share an image; failures are not cached so a retry can succeed.
    const images = yield* Cache.makeWith(fetchImage, {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? "2 minutes" : "0 millis"),
    });

    return Service.of({
      library,
      story,
      chapter,
      image: Effect.fn("Wattpad.image")(function* (url: string) {
        return yield* Cache.get(images, url);
      }),
    });
  }),
);
