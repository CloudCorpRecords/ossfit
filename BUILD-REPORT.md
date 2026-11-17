# BUILD REPORT — ossfit

Clean-room rebuild of `com.leewaystudio/code-synapse` v0.4.2
(remote-only MCP server at
`https://code-synapse-mcp.leewaystudio.com/mcp`), built
2026-10-28 as a forwarding client. Package: `@reneturcios/ossfit`
0.1.0, registry name `io.github.CloudCorpRecords/ossfit`.

## Surface built

Full surface: **2 of 2 captured tools built**, no omissions.

| Tool | Required fields as served |
|------|---------------------------|
| `find_fit_candidates` | `need` |
| `search_components` | `query` |

Each served tool carries exactly the keys `name`, `description`,
`inputSchema`, exactly as captured (the capture carries no `title`
key on either tool, so none is served; the captured `outputSchema`
was dropped at fixture slimming upstream of this build and is not
served). The tool literals were generated programmatically from
`harness/fixtures/codesynapse-tools-original.json` by the script at
`/tmp/laneb4-ossfit-scratch/gen.py` (parse + re-serialise,
placeholder substitution into `src/forward.ts`) — never retyped,
which matters here because the `find_fit_candidates` schema is
deeply nested (a `constraints` object with five sub-schemas, three
of them carrying their own nested `required` arrays). A
post-generation check confirmed the generated literals deep-equal
the fixture's 2 tool objects, in order, and the
registration-integrity test suite plus the parity harness confirm
it again at runtime. Tools are registered via the MCP SDK
low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

Both tools are reads over the vendor's published catalogue of
maintained open-source repositories; nothing is submitted by
either call.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names,
descriptions, required fields (`need` for `find_fit_candidates`,
`query` for `search_components`) and property shapes, including
the nested `constraints` schema.

## Labelled reconstructions (from the spec's Wire section)

- **Endpoint override:** the upstream endpoint is pinned to
  `https://code-synapse-mcp.leewaystudio.com/mcp`; the
  `CODESYNAPSE_MCP_URL` environment override is a labelled
  reconstruction (an explicit `deps.url` wins over it, and a blank
  value falls back to the pinned endpoint).
- **Error rendering:** upstream failures surface as this rebuild's
  own `ossfit error:` text results (labelled reconstruction). A
  successful upstream result — including a result-level `isError`
  from the upstream itself — passes through verbatim and is never
  re-rendered.
- **No auth header:** the registry record declares NO headers on
  the remote, so no `Authorization` header is ever sent, under any
  environment; the tests assert this under the default
  environment, with the endpoint override set, and with
  credential-shaped environment variables present.
- **Wire:** streamable-HTTP JSON-RPC forwarding — initialize →
  notifications/initialized → tools/call, honouring
  `Mcp-Session-Id` when the upstream issues one; plain-JSON and
  SSE replies both parsed. The session opens lazily on the first
  forwarded call and is reused for the client's lifetime.
- **Tests:** fake-fetch only (stubbed JSON-RPC upstream). No live
  network call was made or is claimed; the only live capture is
  the coordinator's tools/list capture embodied in the fixture.

## Lockfile

- Route: **Clean Route 3 from birth** — generated in the build
  directory with no `node_modules` present:
  `npm install --package-lock-only --ignore-scripts --offline`,
  then `npm ci --ignore-scripts --offline` to populate
  `node_modules`.
- Verified: parses as JSON, `name == "@reneturcios/ossfit"`,
  exactly **128 package entries**.
- sha256:
  `16fce2b59a45c47def2a16a26281dcaa1bf910ea8776cc2ae369887481f9b91b`

## server.json

- Description exactly: "Open-source fit finder: maintained OSS
  candidates checked against your project constraints." —
  **91 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/ossfit:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio.
  Dockerfile (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/ossfit"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/ossfit`
  and its smoke test asserts the server name `ossfit`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **50 tests, 50 pass, 0 fail** (registration
   integrity deep-equalling the served tools/list against the
   fixture's 2 tools in order — both as literals and through a
   live in-memory MCP client — session establishment and reuse,
   Mcp-Session-Id handling, endpoint selection and the env
   override, the no-Authorization-header assertions under several
   environments, verbatim argument forwarding including the nested
   constraints object, result pass-through including upstream
   isError, SSE parsing, error rendering including timeout, MCP
   layer validation, and CLI behaviour including `--version`).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/codesynapse-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/ossfit/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/ossfit/parity-out` → **verdict PASS, parity 100.0**
   (2/2 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
