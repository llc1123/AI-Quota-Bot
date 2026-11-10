import { afterEach, expect, it, vi } from "vitest";
import { DetectionJob } from "../src/detection-job";
import { analyzeDetectionOutputs } from "../src/detector";

vi.mock("../src/detector", () => ({
  generateDetectionChallenges: () =>
    [1, 2, 3].map((n) => ({ prompt: `challenge ${n}`, expectedCount: 300 })),
  analyzeDetectionOutputs: vi.fn(() => ({
    prediction: "gpt-5.6-luna",
    probability: 0.9,
    decision: "ranked",
    validOutputs: 3,
  })),
}));

type State = ConstructorParameters<typeof DetectionJob>[0];
const command = { updateId: 10, chatId: -1001234567890, messageId: 42, model: "gpt-5.6-luna" };
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
    .mockImplementation(async () => Response.json({ text: "sample" }));
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

afterEach(() => vi.unstubAllGlobals());

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

it("edits a failure result when one of the three requests fails", async () => {
  const { job, probe, telegram } = harness();
  probe.mockImplementationOnce(async () => new Response("unavailable", { status: 502 }));
  await job.fetch(startRequest());
  await job.alarm();
  expect(probe).toHaveBeenCalledTimes(3);
  const edit = telegram.mock.calls.find(([url]) => String(url).endsWith("/editMessageText"));
  expect(edit?.[1]?.body).toContain("检测失败");
  expect(edit?.[1]?.body).not.toContain("结果一致");
});

it.each([
  ["gpt-6-astra", "gpt-6-astra", "gpt-6-astra/gpt-6.1-sol", "结果一致"],
  ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-astra/gpt-6.1-sol", "结果一致"],
  ["gpt-5.6-luna", "gpt-6-astra", "gpt-6-astra/gpt-6.1-sol", "结果不一致"],
  ["gpt-6.1-sol", "gpt-5.6-luna", "gpt-5.6-luna", "结果不一致"],
  ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-sol", "结果不一致"],
])("handles input %s and fingerprint %s", async (model, prediction, output, agreement) => {
  vi.mocked(analyzeDetectionOutputs).mockReturnValueOnce({
    prediction,
    probability: 0.999,
    decision: "ranked",
    validOutputs: 3,
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
