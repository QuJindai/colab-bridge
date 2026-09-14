import {
  AGENT_VERSION,
  AGENT_WHEEL_BASE64,
  AGENT_WHEEL_FILENAME,
  AGENT_WHEEL_SHA256,
  BOOTSTRAP_INSTALL_ENV_PYTHON,
} from "./bootstrap_payload.ts";
import { jsonRequest, ProviderError, safeHttps } from "./providers.ts";
import type { ProviderConfig } from "./providers.ts";
import { isUuid } from "./jobs.ts";

export function bootstrapCode(
  config: ProviderConfig,
  runtimeId: string,
): string {
  if (!safeHttps(config.agentUrl) || !config.agentKey || !isUuid(runtimeId)) {
    throw new ProviderError("BOOTSTRAP_NOT_CONFIGURED");
  }
  // JSON literals are embedded inside JSON text, then decoded by Python. No code interpolation.
  const packed = JSON.stringify(JSON.stringify({
    url: config.agentUrl,
    key: config.agentKey,
    runtime_id: runtimeId,
    wheel: AGENT_WHEEL_BASE64,
    filename: AGENT_WHEEL_FILENAME,
    sha256: AGENT_WHEEL_SHA256,
    version: AGENT_VERSION,
  }));
  return `import os, re, json, base64, hashlib, tempfile, subprocess, sys, threading\nfrom pathlib import Path\n${BOOTSTRAP_INSTALL_ENV_PYTHON}\n_cb_data = json.loads(${packed})\nif not (globals().get('_colab_bridge_thread') and _colab_bridge_thread.is_alive()):\n    _cb_bytes = base64.b64decode(_cb_data['wheel'], validate=True)\n    assert hashlib.sha256(_cb_bytes).hexdigest() == _cb_data['sha256'], 'Agent checksum mismatch'\n    _cb_path = Path(tempfile.mkdtemp(prefix='colab-bridge-')) / _cb_data['filename']\n    _cb_path.write_bytes(_cb_bytes)\n    _cb_install_env = _colab_bridge_install_env(os.environ)\n    subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'httpx==0.28.1'], check=True, env=_cb_install_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n    subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-deps', '--force-reinstall', str(_cb_path)], check=True, env=_cb_install_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n    from colab_bridge_agent import __version__\n    from colab_bridge_agent.config import AgentConfig\n    from colab_bridge_agent.main import run_agent\n    assert __version__ == _cb_data['version'], 'Agent version mismatch'\n    _colab_bridge_config = AgentConfig(agent_url=_cb_data['url'], agent_key=_cb_data['key'], runtime_id=_cb_data['runtime_id'], label='managed-colab', execution_enabled=True)\n    _colab_bridge_stop = threading.Event()\n    _colab_bridge_thread = threading.Thread(target=run_agent, args=(_colab_bridge_config,), kwargs={'stop_event':_colab_bridge_stop}, daemon=True)\n    _colab_bridge_thread.start()\ndef stop_colab_bridge():\n    _colab_bridge_stop.set()\n    _colab_bridge_thread.join(timeout=20)\ndel _cb_data\n`;
}
export function validateConnectionInfo(
  info: any,
): { url: string; token: string } {
  const url = safeHttps(info?.url);
  if (
    !url || typeof info?.token !== "string" || !info.token ||
    !Number.isFinite(Date.parse(info?.expireTime)) ||
    Date.parse(info.expireTime) < Date.now() + 60000
  ) throw new ProviderError("CONNECTION_INFO_INVALID");
  return { url, token: info.token };
}
export type SocketFactory = (
  url: string,
  headers: Record<string, string>,
) => any;
export class JupyterBootstrap {
  fetcher: typeof fetch;
  socketFactory: SocketFactory;
  constructor(fetcher: typeof fetch, socketFactory: SocketFactory) {
    this.fetcher = fetcher;
    this.socketFactory = socketFactory;
  }
  async createKernel(info: any): Promise<string> {
    const c = validateConnectionInfo(info);
    const d = await jsonRequest(this.fetcher, c.url + "/api/kernels", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Colab-Runtime-Proxy-Token": c.token,
      },
      body: JSON.stringify({ name: "python3" }),
    }, "BOOTSTRAP");
    if (typeof d.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(d.id)) {
      throw new ProviderError("BOOTSTRAP_KERNEL_INVALID");
    }
    return d.id;
  }
  async execute(info: any, kernelId: string, code: string): Promise<void> {
    const c = validateConnectionInfo(info);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(kernelId)) {
      throw new ProviderError("BOOTSTRAP_KERNEL_INVALID");
    }
    const session = crypto.randomUUID(), msgId = crypto.randomUUID();
    const url = c.url.replace(/^https:/, "wss:") +
      `/api/kernels/${kernelId}/channels`;
    await new Promise<void>((resolve, reject) => {
      let socket: any;
      let reply = false, idle = false, settled = false;
      const finish = (code?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close();
        } catch {}
        code ? reject(new ProviderError(code)) : resolve();
      };
      const timer = setTimeout(() => finish("BOOTSTRAP_TIMEOUT"), 60000);
      try {
        socket = this.socketFactory(url, {
          "X-Colab-Runtime-Proxy-Token": c.token,
        });
        socket.on("open", () =>
          socket.send(JSON.stringify({
            header: {
              msg_id: msgId,
              username: "colab-bridge",
              session,
              date: new Date().toISOString(),
              msg_type: "execute_request",
              version: "5.3",
            },
            parent_header: {},
            metadata: {},
            channel: "shell",
            content: {
              code,
              silent: true,
              store_history: false,
              user_expressions: {},
              allow_stdin: false,
              stop_on_error: true,
            },
            buffers: [],
          })));
        socket.on("message", (raw: any) => {
          try {
            const m = JSON.parse(String(raw));
            if (m.parent_header?.msg_id !== msgId) return;
            if (m.header?.msg_type === "execute_reply") {
              if (m.content?.status !== "ok") {
                return finish("BOOTSTRAP_EXECUTION_FAILED");
              }
              reply = true;
            }
            if (
              m.header?.msg_type === "status" &&
              m.content?.execution_state === "idle"
            ) idle = true;
            if (reply && idle) finish();
          } catch {
            finish("BOOTSTRAP_PROTOCOL_ERROR");
          }
        });
        socket.on("error", () => finish("BOOTSTRAP_CONNECTION_FAILED"));
        socket.on("close", () => {
          if (!settled) finish("BOOTSTRAP_CONNECTION_CLOSED");
        });
      } catch {
        finish("BOOTSTRAP_CONNECTION_FAILED");
      }
    });
  }
}
