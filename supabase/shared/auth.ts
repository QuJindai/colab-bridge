export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

export async function verifyKey(raw: string, storedHash: string): Promise<boolean> {
  if (!raw || !isSha256Hex(storedHash)) return false;
  const actual = await sha256Hex(raw);
  let diff = 0;
  for (let i = 0; i < 64; i += 1) {
    diff |= actual.charCodeAt(i) ^ storedHash.toLowerCase().charCodeAt(i);
  }
  return diff === 0;
}

export function extractPresentedKey(url: string, headers: Headers, dedicatedHeader: string): string {
  const dedicated = (headers.get(dedicatedHeader) ?? "").trim();
  if (dedicated) return dedicated;

  const authorization = (headers.get("Authorization") ?? "").trim();
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]?.trim()) return bearerMatch[1].trim();

  try {
    return new URL(url).searchParams.get("access_token")?.trim() ?? "";
  } catch {
    return "";
  }
}

export type BridgeRole = "read" | "control";
export async function authenticateBridge(
  req: Request,
  db: any,
): Promise<
  { ok: true; role: BridgeRole } | {
    ok: false;
    status: number;
    error_code: string;
  }
> {
  const raw = extractPresentedKey(req.url, req.headers, "X-Colab-Bridge-Key");
  if (!raw) return { ok: false, status: 401, error_code: "UNAUTHORIZED" };
  try {
    const { data, error } = await db.from("colab_bridge_access_keys").select(
      "key_kind,key_hash",
    ).in("key_kind", ["bridge", "control"]);
    if (error || !Array.isArray(data)) {
      return { ok: false, status: 503, error_code: "BACKEND_UNAVAILABLE" };
    }
    for (const row of data) {
      if (await verifyKey(raw, row.key_hash)) {
        return {
          ok: true,
          role: row.key_kind === "control" ? "control" : "read",
        };
      }
    }
    return { ok: false, status: 401, error_code: "UNAUTHORIZED" };
  } catch {
    return { ok: false, status: 503, error_code: "BACKEND_UNAVAILABLE" };
  }
}
