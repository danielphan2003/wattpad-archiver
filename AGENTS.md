# AGENTS

`wattpad-archiver` archives a Wattpad library as EPUBs through a CLI and an MCP server. It is TypeScript on
Node 24 with Effect v4.

## Verify

- `pnpm check` runs format, lint, typecheck, and tests. Run it before you finish.
- `pnpm typecheck` runs `tsc-rs`, a drop-in for `tsc` (`typescript` is `@tsc-rs/typescript`). It also reports the Effect diagnostics, which are errors here.
- `pnpm test` runs Vite+ (`vp test run`). Run one file with `vp test run src/Archiver.test.ts`.
- `pnpm build` bundles to `dist/bin.mjs`. Run the bundle, not only the source: `undici` breaks when bundled, which is why it stays external in `vite.config.ts`.

## Layout

- `src/wattpad/` is the Wattpad API: wire schemas in `schema.ts`, the service in `Wattpad.ts`.
- `src/http.ts` wraps the transport with pacing, retries, and cookie scoping.
- `src/Archiver.ts` plans a run, builds each story, and records it in `src/Manifest.ts`.
- `src/epub.ts` and `src/html.ts` are pure: EPUB assembly and chapter sanitising.
- `src/mcp.ts` and `src/cli.ts` are thin. Business rules belong in the services.
- Services use `Context.Service` with `Service`, `Interface`, and `layer` exports, imported as namespaces.

## Rules

- The token is a secret. Never log it, print it, or accept it as a flag or tool argument. It goes to `www.wattpad.com`, and to another `wattpad.com` host only as a retry after a 401 or 403. Never send it outside `wattpad.com`.
- MCP tools never take paths or credentials. Those come from the server's launch configuration.
- Nothing writes to stdout in `mcp` mode except the protocol. The default logger is replaced there.
- Output is quiet by default. Add logging only when it helps someone act.
- Tests follow T3 Code's rules: `it.effect` on `TestClock`, no sleeps, no polling, no wall-clock reads, no per-test timeouts. Extend an existing case before adding one. Lint enforces most of this.
- Do not hit the real Wattpad API in tests. Use the fakes in `src/http.testkit.ts`.
