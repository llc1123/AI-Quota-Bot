export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function fetchJson(
  url: string,
  init?: RequestInit,
  requestTarget = url,
): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${init?.method ?? "GET"} ${requestTarget} failed: ${response.status} ${text}`);
  if (text.trim() === "") return undefined;
  return JSON.parse(text);
}

export function bearerAuth(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
