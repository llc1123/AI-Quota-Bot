import { asString, isRecord } from "./http";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SealedBox {
  version: 1;
  iv: string;
  ciphertext: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function aesKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(base64Key.trim());
  if (raw.byteLength !== 32) throw new Error("CODEX_TOKEN_ENCRYPTION_KEY 必须是 32 字节 base64 值");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealJson(value: unknown, base64Key: string): Promise<SealedBox> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(base64Key),
    encoder.encode(JSON.stringify(value)),
  );
  return {
    version: 1,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function openJson<T>(box: SealedBox, base64Key: string): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(box.iv) },
    await aesKey(base64Key),
    base64UrlToBytes(box.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}

export function jwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const value = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function jwtExpiryMs(token: string): number | undefined {
  const exp = jwtClaims(token)?.["exp"];
  return typeof exp === "number" ? exp * 1000 : undefined;
}

export function chatgptAccountId(token: string): string | undefined {
  const claims = jwtClaims(token);
  if (!claims) return undefined;
  const direct = asString(claims["chatgpt_account_id"]);
  if (direct) return direct;
  const auth = claims["https://api.openai.com/auth"];
  if (isRecord(auth)) {
    const nested = asString(auth["chatgpt_account_id"]);
    if (nested) return nested;
  }
  const organizations = claims["organizations"];
  if (Array.isArray(organizations)) {
    const first = organizations.find(isRecord);
    return first ? asString(first["id"]) : undefined;
  }
  return undefined;
}
