import { fetchJson } from "./http";

export async function sendWecomMarkdown(webhookUrl: string, content: string): Promise<void> {
  await fetchJson(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
  });
}
