# ossfit

Before you write a queue, a parser, a cache or an auth layer yourself — or add a dependency you have not vetted — ossfit asks whether a maintained open-source project already does the job and whether it fits your stack. ossfit is a local forwarding client for the hosted Code Synapse catalogue service: it answers `tools/list` locally from the captured tool definitions and forwards every check upstream, returning the verdicts exactly as the service sends them back.

The upstream corpus is a published catalogue of maintained open-source repositories (GitHub projects with at least 2,000 stars). Nothing is indexed, scored or stored on this machine — the package is a pipe to that catalogue, not a copy of it.

## The tools

- **`find_fit_candidates`** — The pre-adoption decision tool. Send a short capability need (for example, "job queue with retry for node.js") plus your project's minimal constraints — runtime form, protocols, accepted auth models, an SPDX licence allow-list, how recently the project must have been pushed, components you already use, exclusions, a candidate cap, telemetry level and a strict flag. The service returns up to 12 candidates by default (up to 20 when `max_candidates` is set), each with a pass/fail/unknown verdict per constraint, an evidence basis (observed vs inferred), and explicit no-hit semantics. `need` is required.
- **`search_components`** — Deprecated, kept for compatibility: a plain free-text keyword search over the same corpus, with no constraint checking and no verdicts. Returns up to 12 candidates with signals such as role, protocols, affordance, fit and freshness. New integrations should use `find_fit_candidates` instead. `query` is required.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/ossfit mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "ossfit": {
      "command": "npx",
      "args": ["-y", "@reneturcios/ossfit", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/ossfit
docker run --rm ghcr.io/cloudcorprecords/ossfit search_components '{"query":"vector db"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
ossfit find_fit_candidates '{"need":"job queue with retry for node.js","constraints":{"runtime":{"value":"node-lib"}}}'
ossfit search_components '{"query":"music server"}'
ossfit --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `CODESYNAPSE_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://code-synapse-mcp.leewaystudio.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

The upstream registry record declares no headers, so no authentication header is ever sent; the tool surface was captured keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `ossfit error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface, exercises the session handshake and its reuse, verifies the endpoint override and that no `Authorization` header is ever sent, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
