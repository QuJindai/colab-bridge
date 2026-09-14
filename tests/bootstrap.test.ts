import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import {
  bootstrapCode,
  JupyterBootstrap,
  validateConnectionInfo,
} from "../supabase/shared/bootstrap.ts";
import {
  AGENT_WHEEL_BASE64,
  AGENT_WHEEL_SHA256,
} from "../supabase/shared/bootstrap_payload.ts";
import { createHash } from "node:crypto";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("generated wheel payload hashes correctly and bootstrap uses non-history dedicated code", () => {
  assert.equal(
    createHash("sha256").update(Buffer.from(AGENT_WHEEL_BASE64, "base64"))
      .digest("hex"),
    AGENT_WHEEL_SHA256,
  );
  const code = bootstrapCode({
    agentUrl: "https://example.test/agent",
    agentKey: "a\"\n'b",
  }, id);
  assert.ok(code.includes("--no-deps"));
  assert.ok(code.includes("execution_enabled=True"));
  assert.ok(code.includes("runtime_id="));
  assert.throws(
    () =>
      validateConnectionInfo({
        url: "https://example.test/?token=x",
        token: "token",
        expireTime: new Date(Date.now() + 3600000).toISOString(),
      }),
    { code: "CONNECTION_INFO_INVALID" },
  );
});
test("actual WebSocket execute_request requires matching reply AND iopub idle and preserves proxy header", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => server.on("listening", r));
  const port = (server.address() as any).port;
  let request: any;
  let seenHeader: any;
  let idleSent = false;
  server.on("connection", (ws, req) => {
    seenHeader = req.headers["x-colab-runtime-proxy-token"];
    ws.on("message", (raw) => {
      request = JSON.parse(String(raw));
      ws.send(
        JSON.stringify({
          header: { msg_type: "execute_reply" },
          parent_header: { msg_id: "unrelated" },
          content: { status: "error" },
        }),
      );
      ws.send(
        JSON.stringify({
          header: { msg_type: "execute_reply" },
          parent_header: { msg_id: request.header.msg_id },
          content: { status: "ok" },
        }),
      );
      setTimeout(() => {
        idleSent = true;
        ws.send(
          JSON.stringify({
            header: { msg_type: "status" },
            parent_header: { msg_id: request.header.msg_id },
            content: { execution_state: "idle" },
          }),
        );
      }, 30);
    });
  });
  const b = new JupyterBootstrap(
    fetch,
    (_url, headers) => new WebSocket(`ws://127.0.0.1:${port}`, { headers }),
  );
  try {
    await b.execute(
      {
        url: "https://runtime.example",
        token: "proxy-secret",
        expireTime: new Date(Date.now() + 3600000).toISOString(),
      },
      "dedicated-kernel",
      "print(1)",
    );
    assert.equal(idleSent, true);
    assert.equal(seenHeader, "proxy-secret");
    assert.equal(request.channel, "shell");
    assert.equal(request.content.allow_stdin, false);
    assert.equal(request.content.store_history, false);
    assert.equal(request.content.silent, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("provider Python bootstrap is syntactically valid with hostile quote/newline config input", async () => {
  const { spawnSync } = await import("node:child_process");
  const code = bootstrapCode({
    agentUrl: "https://example.test/agent",
    agentKey: "a\"\n'b\\c",
  }, id);
  const result = spawnSync("python3", [
    "-c",
    'import sys; compile(sys.stdin.read(), "bootstrap", "exec")',
  ], { input: code, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("both generated bootstrap paths remove credential-bearing URL values but retain ordinary proxy and TLS settings", async () => {
  const { readFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const notebook = JSON.parse(
    readFileSync("notebooks/colab_bridge_bootstrap.ipynb", "utf8"),
  );
  const sources = [
    notebook.cells.find((c: any) => c.cell_type === "code").source.join(""),
    bootstrapCode({
      agentUrl: "https://agent.example",
      agentKey: "synthetic-key",
    }, id),
  ];
  const inspect =
    `import ast, json, sys\ndata=json.load(sys.stdin)\ntree=ast.parse(data['code'])\nfunctions=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name=='_colab_bridge_install_env']\nassert len(functions)==1\nns={}\nexec(compile(ast.Module(body=functions,type_ignores=[]),'filter','exec'),ns)\nprint(json.dumps(ns['_colab_bridge_install_env'](data['environment'])))`;
  for (const code of sources) {
    for (
      const credentialProxy of [
        "http://synthetic:password@proxy.test:8080",
        "synthetic:password@proxy.test:8080",
        "http://synthetic%3Apassword%40proxy.test:8080",
      ]
    ) {
      const environment = {
        PIP_INDEX_URL: "https://synthetic:password@index.test/simple",
        PIP_EXTRA_INDEX_URL:
          "https://public.test/simple https://synthetic:password@private.test/simple",
        HTTPS_PROXY: credentialProxy,
        HTTP_PROXY: "http://proxy.test:8080",
        ALL_PROXY: "socks5h://proxy.test:1080",
        NO_PROXY: "localhost,127.0.0.1",
        SSL_CERT_FILE: "/configured/ca.pem",
        REQUESTS_CA_BUNDLE: "/configured/ca.pem",
        PATH: "/usr/bin",
        CUSTOM_SETTING: "https://synthetic:password@elsewhere.test",
        PIP_TRUSTED_HOST: "index.test",
      };
      const result = spawnSync("python3", ["-c", inspect], {
        input: JSON.stringify({ code, environment }),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      assert.equal(result.status, 0, result.stderr);
      const clean = JSON.parse(result.stdout);
      for (
        const name of [
          "PIP_INDEX_URL",
          "PIP_EXTRA_INDEX_URL",
          "HTTPS_PROXY",
          "CUSTOM_SETTING",
          "PIP_TRUSTED_HOST",
        ]
      ) assert.equal(name in clean, false, name);
      for (
        const name of [
          "HTTP_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "SSL_CERT_FILE",
          "REQUESTS_CA_BUNDLE",
          "PATH",
        ]
      ) {
        assert.equal(
          clean[name],
          environment[name as keyof typeof environment],
        );
      }
    }
    const environment = {
      https_proxy: "http://proxy.test:8080",
      PIP_INDEX_URL: "https://pypi.org/simple",
      PIP_EXTRA_INDEX_URL: "https://mirror.test/simple",
      PIP_FIND_LINKS: "/wheels",
      PIP_CERT: "/cert.pem",
      SSL_CERT_DIR: "/certs",
    };
    const result = spawnSync("python3", ["-c", inspect], {
      input: JSON.stringify({ code, environment }),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), environment);
  }
});
