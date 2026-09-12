# Colab Bridge

Colab Bridge is a read-only MCP bridge that lets ChatGPT/Codex inspect the **current** compute state of a Google Colab runtime without exposing Jupyter, notebook execution, shell execution, Google credentials, or inbound Colab ports.

## v0.1 scope

The first release exposes seven read-only MCP tools:

- `colab_capabilities`
- `colab_list_runtimes`
- `colab_gpu_status`
- `colab_runtime_status`
- `colab_nvidia_smi`
- `colab_processes`
- `colab_health`

It reports GPU count/model, VRAM, utilization, temperature, power, NVIDIA driver/CUDA information, safe GPU process metadata, Python/PyTorch/runtime metadata, and heartbeat freshness.

## Architecture

```text
ChatGPT / Codex
      |
      | MCP over HTTPS
      v
Supabase Edge Function: colab-bridge-mcp
      |
      v
PostgreSQL telemetry tables
      ^
      |
Supabase Edge Function: colab-bridge-agent
      ^
      | outbound HTTPS only
      |
Google Colab Agent
      +-- fixed nvidia-smi queries
      +-- safe Python/platform probes
      +-- optional torch.cuda metadata
```

Colab never listens on a public port. A runtime reconnect can create a new runtime session while the MCP endpoint remains stable.

## Freshness

- Agent heartbeat target: 20 seconds
- `live`: heartbeat age <= 60 seconds
- `stale`: heartbeat age > 60 and <= 300 seconds
- `offline`: heartbeat age > 300 seconds

MCP responses include telemetry observation time and age. Stale GPU data is not represented as live data.

## Colab bootstrap

Open `notebooks/colab_bridge_bootstrap.ipynb` in Colab and run the single cell. It asks for:

1. the deployed `colab-bridge-agent` Edge Function URL;
2. the agent key;
3. an optional runtime label.

The cell starts the telemetry agent in a daemon thread and prints a local accelerator check for comparison.

## Development tests

```bash
pytest -q agent/tests
npm test
```

The TypeScript suite uses the Node 22 built-in test runner and does not require a test framework download.

## Security

v0.1 is intentionally observation-only. There is no tool, API field, or command type for shell, Python, notebook execution, file access, package installation, Drive access, or arbitrary `nvidia-smi` arguments. See `docs/security.md`.

## Deployment

See `docs/deployment.md` for schema, Edge Function, key seeding, Colab, and MCP app setup.

## License

MIT
