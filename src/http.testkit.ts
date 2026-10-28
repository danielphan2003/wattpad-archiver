import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as Credentials from "./Credentials.ts";
import * as Http from "./http.ts";

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

export const text = (body: string, status = 200) => new Response(body, { status });

export type Handler = (request: HttpClientRequest.HttpClientRequest) => Response;

const respond = (handler: Handler) => (request: HttpClientRequest.HttpClientRequest) =>
  Effect.sync(() => HttpClientResponse.fromWeb(request, handler(request)));

/** A transport that answers from `handler` and records every request it sees. */
export const fakeHttpClient = (
  handler: Handler,
  seen: Array<HttpClientRequest.HttpClientRequest> = [],
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      seen.push(request);
      return respond(handler)(request);
    }),
  );

/** The limited client the Wattpad service sees, with no pacing or retries in front of `handler`. */
export const fakeHttp = (handler: Handler, seen: Array<HttpClientRequest.HttpClientRequest> = []) =>
  Layer.succeed(Http.Service, {
    execute: (request) => {
      seen.push(request);
      return respond(handler)(request);
    },
    executeAuthenticated: (request) => {
      const withToken = HttpClientRequest.setHeader(request, "cookie", `token=${TEST_TOKEN}`);
      seen.push(withToken);
      return respond(handler)(withToken);
    },
  });

export const TEST_TOKEN = "secret-token-value";

export const testCredentials = Layer.succeed(Credentials.Service, {
  username: "reader",
  token: Redacted.make(TEST_TOKEN),
});
