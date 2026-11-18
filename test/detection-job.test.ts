import { afterEach, expect, it, vi } from "vitest";
import { DetectionJob } from "../src/detection-job";
import { analyzeDetectionOutputs } from "../src/detector";
import fixture from "../src/detector/reference-fixture.json";

vi.mock("../src/detector", async () => {
  const detector = await vi.importActual<typeof import("../src/detector")>("../src/detector");
  return {
    ...detector,
    generateDetectionChallenges: () =>
      [1, 2, 3].map((n) => ({ prompt: `challenge ${n}`, expectedCount: 300 })),
    analyzeDetectionOutputs: vi.fn(detector.analyzeDetectionOutputs),
  };
});

type State = ConstructorParameters<typeof DetectionJob>[0];
const command = { updateId: 10, chatId: -1001234567890, messageId: 42, model: fixture.model };
const invalidOutputs = [
  { label: "empty", text: "" },
  { label: "refusal", text: "I cannot complete this task." },
  { label: "insufficient numbers", text: "1,".repeat(164) },
  { label: "out-of-range numbers", text: "999,".repeat(300) },
  {
    label: "sorted non-model sequence",
    text: Array.from({ length: 300 }, (_, i) => i + 1).join(","),
  },
];
const failures = [
  { label: "http", respond: () => new Response("unavailable", { status: 502 }) },
  {
    label: "transport",
    respond: () => {
      throw new TypeError("connection closed");
    },
  },
  { label: "invalid response", respond: () => Response.json({ error: "missing text" }) },
  ...invalidOutputs.map(({ label, text }) => ({ label, respond: () => Response.json({ text }) })),
];
const validResponse = (prompt: string) =>
  Response.json({ text: fixture.samples[Number(prompt.slice(-1)) - 1]?.text });
const startRequest = (model = command.model) =>
  new Request("https://detection.internal/start", {
    method: "POST",
    body: JSON.stringify({ ...command, model }),
  });

function harness() {
  let stored: Awaited<ReturnType<State["storage"]["get"]>>;
  const setAlarm = vi.fn(async () => {});
  const state: State = {
    storage: {
      get: async () => stored,
      put: async (_key, value) => {
        stored = value;
      },
      setAlarm,
    },
    blockConcurrencyWhile: async (callback) => callback(),
  };
  const probe = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, init) => validResponse(JSON.parse(String(init?.body)).prompt));
  const telegram = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ ok: true, result: { message_id: 99 } }));
  vi.stubGlobal("fetch", telegram);
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    CODEX_AUTH: { getByName: () => ({ fetch: probe }) },
  };
  return {
    state,
    job: new DetectionJob(state, env),
    restart: () => new DetectionJob(state, env),
    setAlarm,
    probe,
    telegram,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("deduplicates redelivered updates and edits the initial message after exactly three probes", async () => {
  const { job, restart, probe, telegram, setAlarm } = harness();
  await job.fetch(startRequest());
  await job.fetch(startRequest());
  expect(setAlarm).toHaveBeenCalledOnce();
  expect(probe).not.toHaveBeenCalled();
  await job.alarm();
  await restart().alarm();
  expect(probe).toHaveBeenCalledTimes(3);
  const edits = telegram.mock.calls.filter(([url]) => String(url).endsWith("/editMessageText"));
  expect(edits).toHaveLength(1);
  expect(edits[0]?.[1]?.body).toContain('"message_id":99');
  expect(edits[0]?.[1]?.body).toContain("结果一致");
});

it.each([1, 2].flatMap((count) => failures.map((failure) => ({ count, ...failure }))))(
  "scores $count valid probes after $label probes exhaust their retries",
  async ({ count, respond }) => {
    const { job, probe, telegram } = harness();
    const attempts = new Map<string, number>();
    probe.mockImplementation(async (_url, init) => {
      const { prompt } = JSON.parse(String(init?.body));
      attempts.set(prompt, (attempts.get(prompt) ?? 0) + 1);
      return Number(prompt.slice(-1)) <= count ? validResponse(prompt) : respond();
    });
    await job.fetch(startRequest());
    await job.alarm();
    expect([...attempts.values()]).toEqual([1, count === 2 ? 1 : 4, 4]);
    expect(probe).toHaveBeenCalledTimes(count + (3 - count) * 4);
    expect(analyzeDetectionOutputs).toHaveBeenLastCalledWith(
      fixture.samples.slice(0, count).map(({ text }) => ({
        text,
        expectedCount: 300,
      })),
    );
    const edit = telegram.mock.calls.find(([url]) => String(url).endsWith("/editMessageText"));
    expect(edit?.[1]?.body).toContain("输出模型：claude-haiku-4.5");
    expect(edit?.[1]?.body).toContain("结果一致");
    expect(edit?.[1]?.body).not.toContain("库内匹配概率");
  },
);

it.each([1, 3].flatMap((retries) => failures.map((failure) => ({ retries, ...failure }))))(
  "recovers after $retries retries for $label and stops retrying successful probes",
  async ({ retries, respond }) => {
    const { job, probe, telegram } = harness();
    const attempts = new Map<string, number>();
    probe.mockImplementation(async (_url, init) => {
      const { prompt } = JSON.parse(String(init?.body));
      const attempt = (attempts.get(prompt) ?? 0) + 1;
      attempts.set(prompt, attempt);
      return attempt > retries ? validResponse(prompt) : respond();
    });
    await job.fetch(startRequest());
    await job.alarm();
    expect([...attempts.values()]).toEqual([retries + 1, retries + 1, retries + 1]);
    expect(probe).toHaveBeenCalledTimes(3 * (retries + 1));
    const edit = telegram.mock.calls.find(([url]) => String(url).endsWith("/editMessageText"));
    expect(edit?.[1]?.body).toContain("结果一致");
  },
);

it.each(failures)(
  "reports failure after exactly 12 requests when all probes return $label",
  async ({ respond }) => {
    const { job, probe, telegram } = harness();
    probe.mockImplementation(async () => respond());
    await job.fetch(startRequest());
    await job.alarm();
    expect(probe).toHaveBeenCalledTimes(12);
    expect(
      telegram.mock.calls.filter(([url]) => String(url).endsWith("/editMessageText")),
    ).toHaveLength(1);
    const edit = telegram.mock.calls.find(([url]) => String(url).endsWith("/editMessageText"));
    expect(edit?.[1]?.body).toContain("检测失败");
    expect(edit?.[1]?.body).not.toContain("结果一致");
  },
);

it.each([
  ["gpt-6-astra", "gpt-6-astra", "gpt-6-astra/gpt-6.1-sol", "结果一致"],
  ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-astra/gpt-6.1-sol", "结果一致"],
  ["gpt-5.6-luna", "gpt-6-astra", "gpt-6-astra/gpt-6.1-sol", "结果不一致"],
  ["gpt-6.1-sol", "gpt-5.6-luna", "gpt-5.6-luna", "结果不一致"],
  ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-sol", "结果不一致"],
])("handles input %s and fingerprint %s", async (model, prediction, output, agreement) => {
  const detector = await vi.importActual<typeof import("../src/detector")>("../src/detector");
  vi.mocked(analyzeDetectionOutputs).mockImplementation((outputs) => {
    const result = detector.analyzeDetectionOutputs(outputs);
    return outputs.length === 3 ? { ...result, prediction } : result;
  });
  const { job, probe, telegram } = harness();
  await job.fetch(startRequest(model));
  await job.alarm();
  expect(probe).toHaveBeenCalledTimes(3);
  const edit = telegram.mock.calls.find(([url]) => String(url).endsWith("/editMessageText"));
  expect(edit?.[1]?.body).toContain(`输出模型：${output}\\n${agreement}（指纹推断）`);
});

it("retries result delivery after an edit failure without spending three more model requests", async () => {
  const { job, restart, probe, telegram } = harness();
  telegram
    .mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 99 } }))
    .mockImplementationOnce(async () =>
      Response.json({ ok: false, description: "temporary failure" }, { status: 500 }),
    );
  await job.fetch(startRequest());
  await expect(job.alarm()).rejects.toThrow("Telegram API 拒绝请求");
  await restart().alarm();
  expect(probe).toHaveBeenCalledTimes(3);
  const edits = telegram.mock.calls.filter(([url]) => String(url).endsWith("/editMessageText"));
  expect(edits).toHaveLength(2);
  expect(edits[0]?.[1]?.body).toBe(edits[1]?.[1]?.body);
});

it("reports interruption instead of replaying paid inference when an alarm resumes a running job", async () => {
  const { state, job, restart, probe, telegram } = harness();
  await job.fetch(startRequest());
  const put = state.storage.put;
  vi.spyOn(state.storage, "put").mockImplementationOnce(async (key, value) => {
    await put(key, value);
    throw new Error("isolate terminated");
  });
  await expect(job.alarm()).rejects.toThrow("isolate terminated");
  await restart().alarm();
  expect(probe).not.toHaveBeenCalled();
  const edit = telegram.mock.calls.find(([url]) => String(url).endsWith("/editMessageText"));
  expect(edit?.[1]?.body).toContain("检测任务中断");
});
