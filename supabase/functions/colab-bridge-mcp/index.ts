import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import {
  createMcpHandler,
  McpServer,
} from "npm:@modelcontextprotocol/server@2.0.0";
import * as z from "npm:zod@4.6.5";
import WebSocket from "npm:ws@8.21.3";
import { createBridgeHandler } from "../../shared/mcp_server.ts";
import { LifecycleService } from "../../shared/lifecycle.ts";
import { JupyterBootstrap } from "../../shared/bootstrap.ts";
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const config = {
  googleClientId: Deno.env.get("COLAB_GOOGLE_CLIENT_ID"),
  googleClientSecret: Deno.env.get("COLAB_GOOGLE_CLIENT_SECRET"),
  googleRefreshToken: Deno.env.get("COLAB_GOOGLE_REFRESH_TOKEN"),
  googleQuotaProject: Deno.env.get("COLAB_GOOGLE_QUOTA_PROJECT"),
  externalUrl: Deno.env.get("COLAB_EXTERNAL_WAKE_URL"),
  externalToken: Deno.env.get("COLAB_EXTERNAL_WAKE_TOKEN"),
  agentUrl: Deno.env.get("COLAB_BOOTSTRAP_AGENT_URL"),
  agentKey: Deno.env.get("COLAB_BOOTSTRAP_AGENT_KEY"),
};
const bootstrap = new JupyterBootstrap(
  fetch,
  (url, headers) =>
    new WebSocket(url, {
      headers,
      handshakeTimeout: 15000,
      followRedirects: false,
    }),
);
const lifecycle = new LifecycleService(db, config, fetch, bootstrap);
const handler = createBridgeHandler({
  db,
  lifecycle,
  z,
  McpServer,
  createMcpHandler,
});
Deno.serve((req: Request) => handler.fetch(req));
