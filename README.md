# wattpad-archiver

Archive a Wattpad library as EPUBs, from the command line or over MCP.

It reads the library of the account whose `token` cookie you give it, builds one EPUB per story, and
remembers what it has archived, so later runs only fetch what changed.

## Install

Needs Node 24 or newer.

```sh
pnpm install
pnpm build
node dist/bin.mjs --help
```

## Credentials

Wattpad has no public API, so the tool uses the session cookie of a logged-in browser:

1. Log in to wattpad.com.
2. Open the browser's developer tools, then **Application**, **Cookies**, `https://www.wattpad.com`.
3. Copy the value of `token`. It is an `HttpOnly` cookie, so only the developer tools can show it.
4. Save it to a file readable only by you (`chmod 600`).

The token is a session credential. It is never accepted as a flag or an MCP tool argument and never
printed. It is sent to `www.wattpad.com`. Image hosts such as `img.wattpad.com` get requests without it, since
public images need none; only if one answers 401 or 403 is the request repeated with the token, and only to a
`wattpad.com` host. Hosts outside `wattpad.com` never see it, and images from them are not downloaded.

| Setting          | Flag           | Environment                                    |
| ---------------- | -------------- | ---------------------------------------------- |
| Account          | `--username`   | `WATTPAD_USERNAME`                             |
| Token            | `--token-file` | `WATTPAD_TOKEN_FILE`, or `WATTPAD_TOKEN`       |
| Output directory | `--output`     | `WATTPAD_OUTPUT` (default `./wattpad-archive`) |

## Use

```sh
wattpad-archiver list --pending            # what is new or changed; also checks the token
wattpad-archiver archive --max-stories 5   # a small first run
wattpad-archiver archive                   # everything that is new or changed
wattpad-archiver archive --story 398322420 # one story, without walking the library
```

`archive` prints one summary line and nothing else, and mentions any images it could not download. `--verbose` adds a line per story, `--json` prints the
summary as JSON. It exits non-zero when a story fails.

A full first run is about one request per chapter plus the images, so tens of thousands for a large library.
The tool paces itself (`--rate`, default 15 requests per second) and slows down when Wattpad answers `429`.

## Incremental runs

Each EPUB is `<title> [<story id>].epub`. A log of what was archived sits beside them in
`.wattpad-archiver/state.jsonl`. A story is skipped while its modification date and chapter count match the log
and its file exists. A story missing chapters is retried on the next run. Interrupting a run loses at most the
stories in flight.

## MCP

```sh
wattpad-archiver mcp
```

Serves two tools over stdio: `wattpad_library` (list stories and their archive state, read-only) and
`wattpad_archive` (archive stories). Credentials, the output directory, and pacing come from the server's
environment, so a prompt cannot redirect files or reach the token. An archive call with no `storyIds` is capped at
10 stories by default and 500 at most.

```json
{
  "mcpServers": {
    "wattpad": {
      "command": "node",
      "args": ["/path/to/wattpad-archiver/dist/bin.mjs", "mcp"],
      "env": {
        "WATTPAD_USERNAME": "your-username",
        "WATTPAD_TOKEN_FILE": "/path/to/token",
        "WATTPAD_OUTPUT": "/path/to/archive"
      }
    }
  }
}
```

## Development

```sh
pnpm check       # format, lint, typecheck, test
pnpm typecheck   # tsc-rs, the Rust TypeScript compiler, with the Effect diagnostics
pnpm test
```

The test suite validates generated EPUBs with [`@likecoin/epubcheck-ts`](https://github.com/likecoin/epubcheck-ts),
a TypeScript port of EPUBCheck. It is pinned and used in tests only, never shipped. For the reference result, run
the official [EPUBCheck](https://github.com/w3c/epubcheck) jar on an archived book.

Tooling follows [T3 Code](https://github.com/pingdotgg/t3code): Vite+ for format, lint, test, and the build,
Effect v4 throughout, and the `oxlint-plugin-t3code` rules vendored in `oxlint-plugin-t3code/`.
