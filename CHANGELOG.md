# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Code Synapse MCP server. Both captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `find_fit_candidates` — a pre-adoption fit check that scores maintained open-source candidates against caller-supplied project constraints with per-constraint pass/fail/unknown verdicts; and `search_components` — the deprecated free-text keyword search over the same corpus, served verbatim including its deprecation wording.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `ossfit error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `CODESYNAPSE_MCP_URL`. The upstream record declares no headers, so no auth header is ever sent.
