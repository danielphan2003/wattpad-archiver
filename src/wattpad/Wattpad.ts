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
        Effect.mapError((cause) => new WattpadResponseError({ operation, cause })),
      );

    const readText = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
      response.text.pipe(
        Effect.mapError((cause) => new WattpadResponseError({ operation, cause })),
      );

    const getText = Effect.fn("Wattpad.getText")(function* (
      operation: string,
      target: string,
      request: HttpClientRequest.HttpClientRequest,
    ) {
      const response = yield* send(operation, request);
      const text = yield* readText(operation, response);
      if (response.status >= 400) {
        return yield* classifyFailure(operation, target, response.status, text);
      }
      return text;
    });

    const getJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
      operation: string,
      target: string,
      request: HttpClientRequest.HttpClientRequest,
      schema: S,
    ) =>
      getText(operation, target, request).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
        Effect.mapError((error) =>
          Schema.isSchemaError(error)
            ? new WattpadResponseError({ operation, cause: error })
            : error,
        ),
      );

    const libraryPage = (url: string) =>
      new URL(url).hostname === WATTPAD_HOST
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

    const library = Stream.paginate(firstPage, (url) =>
      libraryPage(url).pipe(
        Effect.map((page) => [page.stories, Option.fromNullishOr(page.nextUrl)] as const),
      ),
    );

    const story = Effect.fn("Wattpad.story")(function* (id: string) {
      const url = `${API}/stories/${encodeURIComponent(id)}?${new URLSearchParams({ fields: STORY_FIELDS })}`;
      return yield* getJson("story", `story ${id}`, HttpClientRequest.get(url), Story);
    });

    const chapter = Effect.fn("Wattpad.chapter")(function* (part: Part) {
      const html = yield* getText(
        "chapter",
        `chapter ${part.id}`,
        HttpClientRequest.get(part.text_url.text),
      );
      // A chapter that cannot be served comes back as an API error body with a success status.
      const failure = Option.getOrUndefined(decodeApiFailure(html));
      if (failure !== undefined) {
        return yield* classifyFailure("chapter", `chapter ${part.id}`, 200, html);
      }
      return html;
    });

    const fetchImage = Effect.fn("Wattpad.fetchImage")(function* (url: string) {
      const request = HttpClientRequest.get(url);
      const open = yield* send("image", request);
      // Public images need no token. A host that wants one says so, and only then does it get the token.
      const response =
        open.status === 401 || open.status === 403 ? yield* send("image", request, true) : open;
      if (response.status >= 400) {
        return yield* new WattpadRequestError({ operation: "image", status: response.status });
      }
      const buffer = yield* response.arrayBuffer.pipe(
        Effect.mapError((cause) => new WattpadResponseError({ operation: "image", cause })),
      );
      const mediaType = (response.headers["content-type"] ?? "image/jpeg").split(";")[0]?.trim();
      return {
        bytes: new Uint8Array(buffer),
        mediaType: mediaType ?? "image/jpeg",
      } satisfies Image;
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
