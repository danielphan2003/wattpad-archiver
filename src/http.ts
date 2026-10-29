import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { RateLimiter } from "effect/persistence";

import * as Credentials from "./Credentials.ts";
import { isWattpadHttpsUrl } from "./wattpad/urls.ts";

export const WATTPAD_HOST = "www.wattpad.com";
export const DEFAULT_REQUESTS_PER_SECOND = 15;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

type Execute = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError | RateLimiter.RateLimiterError
>;

export interface Interface {
  /** Sends the token to `www.wattpad.com` only. */
  readonly execute: Execute;
  /** Also sends the token to other `wattpad.com` hosts, for a retry after one of them answers 401 or 403. */
  readonly executeAuthenticated: Execute;
}

export class Service extends Context.Service<Service, Interface>()(
  "wattpad-archiver/http/Service",
) {}

export interface Options {
  readonly requestsPerSecond: number;
  readonly maxRetries: number;
}

const parsed = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/** The token goes to `www.wattpad.com` over https, and nowhere else. */
const isApiUrl = (url: string) => {
  const target = parsed(url);
  return target?.protocol === "https:" && target.hostname === WATTPAD_HOST;
};

/**
 * Paces requests with a token bucket that backs off on `429`, retries transient failures,
 * and sends the token cookie to `https://www.wattpad.com` only. Other `https` `wattpad.com` hosts, such as
 * the image CDN, get it only through `executeAuthenticated`, which callers use after the host refuses
 * a request without it. Plain `http` and hosts outside `wattpad.com` never get it.
 */
export const make = Effect.fn("Http.make")(function* (options: Options) {
  const client = yield* HttpClient.HttpClient;
  const limiter = yield* RateLimiter.RateLimiter;
  const credentials = yield* Credentials.Service;
  const cookie = `token=${Redacted.value(credentials.token)}`;

  // Both clients share one limiter key, so the budget is one request budget, not two.
  const limit = (sendsToken: (url: string) => boolean) =>
    client.pipe(
      HttpClient.mapRequest((request) =>
        sendsToken(request.url)
          ? request.pipe(
              HttpClientRequest.setHeader("cookie", cookie),
              HttpClientRequest.setHeader("user-agent", USER_AGENT),
            )
          : HttpClientRequest.setHeader(request, "user-agent", USER_AGENT),
      ),
      HttpClient.retryTransient({
        schedule: Schedule.exponential(Duration.millis(250)).pipe(Schedule.jittered),
        times: options.maxRetries,
      }),
      HttpClient.withRateLimiter({
        limiter,
        key: "wattpad",
        algorithm: "token-bucket",
        window: Duration.seconds(1),
        limit: options.requestsPerSecond,
        times: options.maxRetries,
      }),
    );

  const scoped = limit(isApiUrl);
  const authenticated = limit(isWattpadHttpsUrl);
  return Service.of({ execute: scoped.execute, executeAuthenticated: authenticated.execute });
});

export const layerLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

/** One keep-alive HTTP/2 connection pool behind {@link make}. */
export const layer = (options: Options) =>
  Layer.effect(Service, make(options)).pipe(
    Layer.provide(layerLimiter),
    Layer.provide(NodeHttpClient.layerUndiciOptions({ allowH2: true, connections: 4 })),
  );
