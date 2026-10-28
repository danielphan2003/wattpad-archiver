import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { HttpClientRequest } from "effect/http";

import { fakeHttp, type Handler, json, testCredentials, text } from "../http.testkit.ts";
import type { Part } from "./schema.ts";
import * as Wattpad from "./Wattpad.ts";

const provide = (handler: Handler, seen: Array<HttpClientRequest.HttpClientRequest> = []) =>
  Effect.provide(
    Wattpad.layer.pipe(Layer.provide(fakeHttp(handler, seen)), Layer.provide(testCredentials)),
  );

const libraryStory = (id: string) => ({
  id,
  title: `Story ${id}`,
  modifyDate: "2026-01-01T00:00:00Z",
  numParts: 3,
});

const part = (id: number): Part => ({
  id,
  title: "One",
  url: `https://www.wattpad.com/${id}`,
  modifyDate: "2026-01-01T00:00:00Z",
  text_url: { text: `https://www.wattpad.com/apiv2/?m=storytext&id=${id}&page=` },
});

const NEXT_PAGE = "https://www.wattpad.com/api/v3/users/reader/library?cursor=two";

describe("Wattpad.library", () => {
  it.effect("follows the cursor to the last page and keeps the listing free of chapters", () =>
    Effect.gen(function* () {
      const seen: Array<HttpClientRequest.HttpClientRequest> = [];
      const ids = yield* Effect.gen(function* () {
        const wattpad = yield* Wattpad.Service;
        const stories = yield* wattpad.library.pipe(Stream.runCollect);
        return stories.map((story) => story.id);
      }).pipe(
        provide(
          (request) =>
            request.url.includes("cursor=two")
              ? json({ stories: [libraryStory("c")] })
              : json({ stories: [libraryStory("a"), libraryStory("b")], nextUrl: NEXT_PAGE }),
          seen,
        ),
      );

      expect(ids).toEqual(["a", "b", "c"]);
      expect(seen.map((request) => request.url)).toHaveLength(2);
      const first = new URL(seen[0]!.url);
      expect(first.pathname).toBe("/api/v3/users/reader/library");
      expect(first.searchParams.get("fields")).not.toContain("parts(");
    }),
  );

  it.effect("refuses a next page outside wattpad.com", () =>
    Effect.gen(function* () {
      const seen: Array<HttpClientRequest.HttpClientRequest> = [];
      const error = yield* Effect.gen(function* () {
        const wattpad = yield* Wattpad.Service;
        return yield* wattpad.library.pipe(Stream.runCollect, Effect.flip);
      }).pipe(
        provide(
          () => json({ stories: [libraryStory("a")], nextUrl: "https://evil.example/steal" }),
          seen,
        ),
      );

      expect(error._tag).toBe("WattpadResponseError");
      expect(seen).toHaveLength(1);
    }),
  );
});

describe("Wattpad failures", () => {
  it.effect.each([
    {
      name: "a rejected token",
      response: () => json({ error_type: "PermissionDenied", message: "User not logged in" }, 400),
      tag: "WattpadAuthError",
    },
    {
      name: "a missing story",
      response: () => json({ error_type: "NotFound", message: "no such story" }, 400),
      tag: "WattpadNotFoundError",
    },
    {
      name: "a server error",
      response: () => text("upstream exploded", 502),
      tag: "WattpadRequestError",
    },
    {
      name: "a body that is not the expected shape",
      response: () => json({ unexpected: true }),
      tag: "WattpadResponseError",
    },
  ])("classifies $name", ({ response, tag }) =>
    Effect.gen(function* () {
      const wattpad = yield* Wattpad.Service;
      const error = yield* wattpad.story("1").pipe(Effect.flip);
      expect(error._tag).toBe(tag);
    }).pipe(provide(response)),
  );

  it.effect("returns chapter HTML untouched", () =>
    Effect.gen(function* () {
      const wattpad = yield* Wattpad.Service;
      expect(yield* wattpad.chapter(part(7))).toBe("<p>text</p>");
    }).pipe(provide(() => text("<p>text</p>"))),
  );

  it.effect(
    "treats an error body served with a success status as a failure, not chapter text",
    () =>
      Effect.gen(function* () {
        const wattpad = yield* Wattpad.Service;
        const error = yield* wattpad.chapter(part(7)).pipe(Effect.flip);
        expect(error._tag).toBe("WattpadNotFoundError");
      }).pipe(provide(() => text('{"error_type":"NotFound","message":"gone"}'))),
  );
});

describe("Wattpad.image", () => {
  it.effect("asks for the token only when the image host refuses without it", () =>
    Effect.gen(function* () {
      const seen: Array<HttpClientRequest.HttpClientRequest> = [];
      yield* Effect.gen(function* () {
        const wattpad = yield* Wattpad.Service;
        yield* wattpad.image("https://img.wattpad.com/public.png");
        yield* wattpad.image("https://img.wattpad.com/private.png");
      }).pipe(
        provide((request) => {
          const needsToken =
            request.url.endsWith("private.png") && request.headers.cookie === undefined;
          return needsToken
            ? new Response("forbidden", { status: 403 })
            : new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
        }, seen),
      );

      expect(
        seen.map((request) => [request.url.split("/").pop(), request.headers.cookie === undefined]),
      ).toEqual([
        ["public.png", true],
        ["private.png", true],
        ["private.png", false],
      ]);
    }),
  );

  it.effect("shares one download between concurrent callers and does not cache a failure", () =>
    Effect.gen(function* () {
      const seen: Array<HttpClientRequest.HttpClientRequest> = [];
      let attempts = 0;
      yield* Effect.gen(function* () {
        const wattpad = yield* Wattpad.Service;
        const url = "https://img.wattpad.com/a.png";
        const [first, second] = yield* Effect.all([wattpad.image(url), wattpad.image(url)], {
          concurrency: 2,
        });
        expect(first.mediaType).toBe("image/png");
        expect(second.bytes).toEqual(first.bytes);
        expect(seen).toHaveLength(1);

        const broken = "https://img.wattpad.com/b.png";
        yield* wattpad.image(broken).pipe(Effect.flip);
        yield* wattpad.image(broken);
        expect(attempts).toBe(2);
      }).pipe(
        provide((request) => {
          if (request.url.endsWith("b.png")) {
            attempts += 1;
            return attempts === 1
              ? new Response("nope", { status: 404 })
              : new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } });
          }
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          });
        }, seen),
      );
    }),
  );
});
