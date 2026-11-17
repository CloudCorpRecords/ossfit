import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  OssfitClient,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Code Synapse endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/codesynapse-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const FIT = "find_fit_candidates";
const SEARCH = "search_components";
const ALL_TOOLS = [FIT, SEARCH];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"candidates\":[]}" }],
  structuredContent: { candidates: [] },
};

const SAMPLE_ARGS = {
  need: "job queue with retry for node.js",
  constraints: {
    runtime: { value: "node-lib", required: true },
    license: { allow_spdx: ["MIT", "Apache-2.0"], required: false },
    pushed_within_days: 90,
  },
  existing_components: ["acme/widgets"],
  max_candidates: 5,
  strict: true,
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  initStatus?: number;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function sseResponse(payload: unknown, extraPayload?: unknown) {
  const lines = ["event: message"];
  if (extraPayload !== undefined) {
    lines.push(`data: ${JSON.stringify(extraPayload)}`);
    lines.push("", "event: message");
  }
  lines.push(`data: ${JSON.stringify(payload)}`);
  return makeResponse(200, lines.join("\n") + "\n", {
    "content-type": "text/event-stream",
  });
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(options.initStatus ?? 200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      if (options.initStatus !== undefined && options.initStatus !== 200) {
        return makeResponse(options.initStatus, "upstream unavailable");
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "code-synapse", version: "0.4.2" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("The operation was aborted"));
              return;
            }
            signal.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        const decoy = {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progress: 1 },
        };
        return sseResponse(payload, decoy);
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    throw new Error(`unexpected method: ${method}`);
  };
  return { fetchFn, calls };
}

function headerNames(call: Captured): string[] {
  return Object.keys(call.headers).map((h) => h.toLowerCase());
}

describe("registration integrity (captured surface)", () => {
  it("served tool literals deep-equal the fixture's 2 tools, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("registers exactly the 2 captured tools, in fixture order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(TOOL_DEFS.length, 2);
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
    assert.deepEqual(
      fixture.tools.map((t) => t.name),
      ALL_TOOLS,
    );
  });

  it("the live MCP server's tools/list deep-equals the fixture", async (t) => {
    if (skipWithoutFixture(t)) return;
    const server = createServer({
      fetchFn: async () => {
        throw new Error("tools/list must be answered locally");
      },
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "integrity-check", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools, fixture.tools);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("each tool carries exactly the captured keys (no invented title)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
      ]);
      assert.equal("title" in tool, false);
    }
  });

  it("required fields match the capture: need for find_fit_candidates, query for search_components", () => {
    const byName = new Map(TOOL_DEFS.map((t) => [t.name, t]));
    assert.deepEqual(byName.get(FIT)?.inputSchema.required, ["need"]);
    assert.deepEqual(byName.get(SEARCH)?.inputSchema.required, ["query"]);
  });

  it("the find_fit_candidates constraints schema is served with its nested shape intact", () => {
    const fit = TOOL_DEFS.find((t) => t.name === FIT);
    const schema = fit?.inputSchema as {
      properties: {
        constraints: { properties: Record<string, { required?: string[] }> };
      };
    };
    assert.deepEqual(schema.properties.constraints.properties.runtime.required, [
      "value",
    ]);
    assert.deepEqual(schema.properties.constraints.properties.auth.required, [
      "allow",
    ]);
    assert.deepEqual(
      schema.properties.constraints.properties.license.required,
      ["allow_spdx"],
    );
  });

  it("isKnownTool accepts exactly the captured names", () => {
    assert.equal(isKnownTool(FIT), true);
    assert.equal(isKnownTool(SEARCH), true);
    assert.equal(isKnownTool("find_candidates"), false);
    assert.equal(isKnownTool(""), false);
  });

  it("version and pinned endpoint are the declared ones", () => {
    assert.equal(VERSION, "0.1.0");
    assert.equal(
      DEFAULT_ENDPOINT_URL,
      "https://code-synapse-mcp.leewaystudio.com/mcp",
    );
  });
});

describe("session establishment and reuse", () => {
  it("opens lazily: constructing a client makes no requests", () => {
    const { fetchFn, calls } = makeUpstream();
    createClient({ fetchFn });
    assert.equal(calls.length, 0);
  });

  it("runs initialize -> notifications/initialized -> tools/call, in order", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({ fetchFn });
    await client.callTool(SEARCH, { query: "vector db" });
    assert.deepEqual(
      calls.map((c) => c.body.method),
      ["initialize", "notifications/initialized", "tools/call"],
    );
  });

  it("initialize announces this client and the pinned protocol version", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({ fetchFn });
    await client.callTool(SEARCH, { query: "queue" });
    const params = calls[0].body.params as {
      protocolVersion: string;
      clientInfo: { name: string; version: string };
    };
    assert.equal(params.protocolVersion, PROTOCOL_VERSION);
    assert.equal(params.clientInfo.name, "ossfit");
    assert.equal(params.clientInfo.version, "0.1.0");
  });

  it("carries the issued Mcp-Session-Id on the notification and the call", async () => {
    const { fetchFn, calls } = makeUpstream({ sessionId: "sess-42" });
    const client = createClient({ fetchFn });
    await client.callTool(SEARCH, { query: "queue" });
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-42");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-42");
  });

  it("sends no session header when the upstream issues none", async () => {
    const { fetchFn, calls } = makeUpstream({ sessionId: null });
    const client = createClient({ fetchFn });
    await client.callTool(SEARCH, { query: "queue" });
    for (const call of calls) {
      assert.equal(call.headers["Mcp-Session-Id"], undefined);
    }
  });

  it("reuses one session across calls: a single initialize for two calls", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({ fetchFn });
    await client.callTool(SEARCH, { query: "queue" });
    await client.callTool(FIT, { need: "cache for node.js" });
    assert.deepEqual(
      calls.map((c) => c.body.method),
      [
        "initialize",
        "notifications/initialized",
        "tools/call",
        "tools/call",
      ],
    );
  });
});

describe("no Authorization header is ever sent (record declares no headers)", () => {
  it("sends no Authorization header under the default environment", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({ fetchFn, env: {} });
    await client.callTool(FIT, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(headerNames(call).includes("authorization"), false);
    }
  });

  it("sends no Authorization header when CODESYNAPSE_MCP_URL is set", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({
      fetchFn,
      env: { CODESYNAPSE_MCP_URL: "https://example.invalid/mcp" },
    });
    await client.callTool(SEARCH, { query: "scraping" });
    for (const call of calls) {
      assert.equal(headerNames(call).includes("authorization"), false);
    }
  });

  it("sends no Authorization header even when credential-shaped env vars exist", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({
      fetchFn,
      env: {
        CODESYNAPSE_API_KEY: "sk-should-never-be-sent",
        AUTHORIZATION: "Bearer should-never-be-sent",
        GITHUB_TOKEN: "ghp_should_never_be_sent",
      },
    });
    await client.callTool(FIT, SAMPLE_ARGS);
    for (const call of calls) {
      assert.equal(headerNames(call).includes("authorization"), false);
      assert.equal(headerNames(call).includes("x-api-key"), false);
    }
  });

  it("the only headers sent are content negotiation plus the session id", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({ fetchFn, env: {} });
    await client.callTool(SEARCH, { query: "queue" });
    assert.deepEqual(headerNames(calls[0]).sort(), ["accept", "content-type"]);
    assert.deepEqual(headerNames(calls[2]).sort(), [
      "accept",
      "content-type",
      "mcp-session-id",
    ]);
  });
});

describe("endpoint selection", () => {
  it("posts to the pinned default endpoint", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({ fetchFn, env: {} });
    await client.callTool(SEARCH, { query: "queue" });
    for (const call of calls) {
      assert.equal(call.url, "https://code-synapse-mcp.leewaystudio.com/mcp");
    }
  });

  it("CODESYNAPSE_MCP_URL overrides the pinned endpoint", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({
      fetchFn,
      env: { CODESYNAPSE_MCP_URL: "https://mirror.example.test/mcp" },
    });
    await client.callTool(SEARCH, { query: "queue" });
    for (const call of calls) {
      assert.equal(call.url, "https://mirror.example.test/mcp");
    }
  });

  it("an explicit deps.url wins over the environment override", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({
      fetchFn,
      url: "https://direct.example.test/mcp",
      env: { CODESYNAPSE_MCP_URL: "https://mirror.example.test/mcp" },
    });
    await client.callTool(SEARCH, { query: "queue" });
    assert.equal(calls[0].url, "https://direct.example.test/mcp");
  });

  it("a blank CODESYNAPSE_MCP_URL falls back to the pinned endpoint", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({
      fetchFn,
      env: { CODESYNAPSE_MCP_URL: "   " },
    });
    await client.callTool(SEARCH, { query: "queue" });
    assert.equal(calls[0].url, DEFAULT_ENDPOINT_URL);
  });
});

describe("tools/call forwarding", () => {
  it("forwards the tool name and arguments verbatim, nested constraints included", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({ fetchFn });
    await client.callTool(FIT, SAMPLE_ARGS);
    const params = calls[2].body.params as {
      name: string;
      arguments: unknown;
    };
    assert.equal(params.name, FIT);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a search_components query verbatim", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = createClient({ fetchFn });
    await client.callTool(SEARCH, { query: "music server" });
    const params = calls[2].body.params as {
      name: string;
      arguments: unknown;
    };
    assert.equal(params.name, SEARCH);
    assert.deepEqual(params.arguments, { query: "music server" });
  });

  it("returns a successful upstream result exactly as received", async () => {
    const rich = {
      content: [{ type: "text", text: "{\"candidates\":[1]}" }],
      structuredContent: { candidates: [{ repo: "acme/queue" }] },
      _meta: { trace: "t-1" },
    };
    const { fetchFn } = makeUpstream({ callResult: rich });
    const client = createClient({ fetchFn });
    const result = await client.callTool(FIT, SAMPLE_ARGS);
    assert.deepEqual(result, rich);
  });

  it("passes an upstream isError result through verbatim instead of re-rendering it", async () => {
    const upstreamError = {
      content: [
        { type: "text", text: "runtime value not recognised: wasm" },
      ],
      isError: true,
    };
    const { fetchFn } = makeUpstream({ callResult: upstreamError });
    const client = createClient({ fetchFn });
    const result = await client.callTool(FIT, SAMPLE_ARGS);
    assert.deepEqual(result, upstreamError);
    const text = (result.content as { text: string }[])[0].text;
    assert.equal(text.startsWith("ossfit error:"), false);
  });

  it("parses an SSE-framed tools/call reply and returns its result", async () => {
    const { fetchFn } = makeUpstream({ sse: true });
    const client = createClient({ fetchFn });
    const result = await client.callTool(SEARCH, { query: "vector db" });
    assert.deepEqual(result, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards through a fresh client", async () => {
    const { fetchFn, calls } = makeUpstream();
    const result = await callTool(SEARCH, { query: "cache" }, { fetchFn });
    assert.deepEqual(result, SAMPLE_RESULT);
    assert.equal(calls.length, 3);
  });
});

describe("upstream failures surface as ossfit error text", () => {
  function firstText(result: ToolResult): string {
    return (result.content as { text: string }[])[0].text;
  }

  it("a JSON-RPC error on tools/call becomes an ossfit error result", async () => {
    const { fetchFn } = makeUpstream({
      callError: { code: -32602, message: "need is required" },
    });
    const client = createClient({ fetchFn });
    const result = await client.callTool(FIT, {});
    assert.equal(result.isError, true);
    assert.equal(firstText(result), "ossfit error: need is required");
  });

  it("a non-2xx tools/call status becomes an ossfit error result", async () => {
    const { fetchFn } = makeUpstream({
      callStatus: 500,
      callBodyText: "internal error",
    });
    const client = createClient({ fetchFn });
    const result = await client.callTool(SEARCH, { query: "queue" });
    assert.equal(result.isError, true);
    assert.equal(firstText(result), "ossfit error: HTTP 500");
  });

  it("an unparseable tools/call body becomes a malformed-response error", async () => {
    const { fetchFn } = makeUpstream({ callBodyText: "<html>oops</html>" });
    const client = createClient({ fetchFn });
    const result = await client.callTool(SEARCH, { query: "queue" });
    assert.equal(result.isError, true);
    assert.equal(firstText(result), "ossfit error: malformed response");
  });

  it("a fetch that throws on tools/call becomes a request-failed error", async () => {
    const { fetchFn } = makeUpstream({ throwOn: "tools/call" });
    const client = createClient({ fetchFn });
    const result = await client.callTool(SEARCH, { query: "queue" });
    assert.equal(result.isError, true);
    assert.equal(
      firstText(result),
      "ossfit error: request failed: socket hang up",
    );
  });

  it("a JSON-RPC error on initialize becomes an ossfit error result", async () => {
    const { fetchFn, calls } = makeUpstream({
      initError: { code: -32000, message: "handshake refused" },
    });
    const client = createClient({ fetchFn });
    const result = await client.callTool(SEARCH, { query: "queue" });
    assert.equal(result.isError, true);
    assert.equal(firstText(result), "ossfit error: handshake refused");
    assert.equal(calls.length, 1);
  });

  it("a non-2xx initialize status becomes an ossfit error result", async () => {
    const { fetchFn } = makeUpstream({ initStatus: 503 });
    const client = createClient({ fetchFn });
    const result = await client.callTool(SEARCH, { query: "queue" });
    assert.equal(result.isError, true);
    assert.equal(firstText(result), "ossfit error: HTTP 503");
  });

  it("a tools/call that never answers times out as an ossfit error result", async () => {
    const { fetchFn } = makeUpstream({ hangOnCall: true });
    const client = createClient({ fetchFn, timeoutMs: 25 });
    const result = await client.callTool(SEARCH, { query: "queue" });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /^ossfit error: request failed: /);
  });
});

describe("parseRpcBody", () => {
  it("parses a plain JSON body", () => {
    assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{}}', 1), {
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("returns null for an empty body", () => {
    assert.equal(parseRpcBody("   "), null);
  });

  it("returns null for a body with no JSON in it", () => {
    assert.equal(parseRpcBody("not json at all"), null);
  });

  it("picks the SSE message whose id matches the request", () => {
    const body = [
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      "",
      'data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}',
    ].join("\n");
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body = 'data: {"jsonrpc":"2.0","id":3,"result":{}}\n\ndata: [DONE]';
    assert.deepEqual(parseRpcBody(body, 3), {
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });
  });
});

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = new OssfitClient({ fetchFn });
    await assert.rejects(
      handleCallTool(client, "not_a_tool", {}),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal((err as McpError).code, ErrorCode.MethodNotFound);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it("rejects non-object arguments with InvalidParams before any network hop", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = new OssfitClient({ fetchFn });
    await assert.rejects(
      handleCallTool(client, FIT, ["need"]),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal((err as McpError).code, ErrorCode.InvalidParams);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it("forwards a known tool call and returns the upstream result", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = new OssfitClient({ fetchFn });
    const result = await handleCallTool(client, SEARCH, { query: "parser" });
    assert.deepEqual(result, SAMPLE_RESULT);
    assert.equal(calls.length, 3);
  });

  it("treats omitted arguments as an empty object", async () => {
    const { fetchFn, calls } = makeUpstream();
    const client = new OssfitClient({ fetchFn });
    await handleCallTool(client, SEARCH, undefined);
    const params = calls[2].body.params as { arguments: unknown };
    assert.deepEqual(params.arguments, {});
  });
});

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /find_fit_candidates, search_components/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([FIT, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([FIT, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
