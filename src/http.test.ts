import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import * as Http from "./http.ts";
import { fakeHttpClient, TEST_TOKEN, testCredentials } from "./http.testkit.ts";

const run = (
  handler: Parameters<typeof fakeHttpClient>[0],
  seen: Array<HttpClientRequest.HttpClientRequest>,
) =>
  Effect.provide(Layer.mergeAll(fakeHttpClient(handler, seen), Http.layerLimiter, testCredentials));

const OPTIONS = { requestsPerSecond: 100, maxRetries: 3 };

describe("Http", () => {
  it.effect("sends the token cookie to www.wattpad.com and to no other host", () =>
    Effect.gen(function* () {
      const seen: Array<HttpClientRequest.HttpClientRequest> = [];
      yield* Effect.gen(function* () {
        const http = yield* Http.make(OPTIONS);
        yield* http.execute(HttpClientRequest.get("https://www.wattpad.com/api/v3/stories/1"));
        yield* http.execute(HttpClientRequest.get("https://img.wattpad.com/cover/1.jpg"));
        yield* http.execute(HttpClientRequest.get("https://evil.example/pixel.png"));
      }).pipe(run(() => new Response("ok"), seen));

      expect(seen.map((request) => request.headers.cookie)).toEqual([
        `token=${TEST_TOKEN}`,
        undefined,
        undefined,
      ]);
    }),
  );

  it.effect("waits out a 429 and then succeeds", () =>
    Effect.gen(function* () {
      const seen: Array<HttpClientRequest.HttpClientRequest> = [];
      const response = yield* Effect.gen(function* () {
        const http = yield* Http.make(OPTIONS);
        const fiber = yield* http
          .execute(HttpClientRequest.get("https://www.wattpad.com/api/v3/stories/1"))
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(
        run(
          () =>
            seen.length === 1
              ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
              : new Response("ok"),
          seen,
        ),
      );

      expect(response.status).toBe(200);
      expect(seen).toHaveLength(2);
    }),
  );
});
