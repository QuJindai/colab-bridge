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
