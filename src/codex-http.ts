export type CodexUsageRelay = {
  readonly url: string;
  readonly token: string;
};

async function jsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (response.ok) return text.trim() ? JSON.parse(text) : undefined;
  const blocked = text.includes("Unable to load site");
  if (blocked)
    throw new Error("Codex usage blocked by OpenAI before authentication in Worker fetch");
  throw new Error(`Codex usage failed: HTTP ${response.status}`);
}

async function relayUsageRequest(relay: CodexUsageRelay, accessToken: string): Promise<unknown> {
  const response = await fetch(relay.url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-relay-token": relay.token,
    },
  });
  return jsonResponse(response);
}

export async function codexUsageRequest(
  url: string,
  accessToken: string,
  relay?: CodexUsageRelay,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "user-agent": "codex-cli",
    },
  });
  try {
    return await jsonResponse(response);
  } catch (error) {
    if (
      relay &&
      error instanceof Error &&
      error.message === "Codex usage blocked by OpenAI before authentication in Worker fetch"
    ) {
      return relayUsageRequest(relay, accessToken);
    }
    throw error;
  }
}
