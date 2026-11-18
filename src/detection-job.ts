import { z } from "zod";
import { analyzeDetectionOutputs, generateDetectionChallenges } from "./detector";
import { requiredEnv } from "./env";
import { json } from "./http";
import { editTelegramMessage, sendTelegramMessage } from "./telegram-api";

const commandSchema = z.object({
  updateId: z.number().int(),
  chatId: z.number().int().negative(),
  messageId: z.number().int().positive(),
  messageThreadId: z.number().int().positive().optional(),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/),
});
type Command = z.infer<typeof commandSchema>;
type Job =
  | { readonly stage: "pending"; readonly command: Command }
  | { readonly stage: "running"; readonly command: Command; readonly replyId: number }
  | {
      readonly stage: "result";
      readonly command: Command;
      readonly replyId: number;
      readonly text: string;
    }
  | { readonly stage: "done" };
type JobState = {
  readonly storage: {
    readonly get: (key: "job") => Promise<Job | undefined>;
    readonly put: (key: "job", value: Job) => Promise<void>;
    readonly setAlarm: (time: number) => Promise<void>;
  };
  readonly blockConcurrencyWhile: <T>(callback: () => Promise<T>) => Promise<T>;
};
const probeResponseSchema = z.object({ text: z.string().max(64_000) });
const PROBE_MAX_RETRIES = 3;

class DetectionError extends Error {}

type DetectionEnv = {
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly CODEX_AUTH: {
    readonly getByName: (name: string) => { readonly fetch: typeof fetch };
  };
};

export class DetectionJob {
  constructor(
    private readonly state: JobState,
    private readonly env: DetectionEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    const command = commandSchema.safeParse(await request.json());
    if (!command.success) return json({ error: "invalid_detection" }, 400);
    await this.state.blockConcurrencyWhile(async () => {
      if (await this.state.storage.get("job")) return;
      await Promise.all([
        this.state.storage.put("job", { stage: "pending", command: command.data }),
        this.state.storage.setAlarm(Date.now()),
      ]);
    });
    return json({ ok: true });
  }

  async alarm(): Promise<void> {
    const job = await this.state.storage.get("job");
    if (!job || job.stage === "done") return;
    const token = requiredEnv(this.env, "TELEGRAM_BOT_TOKEN");
    if (job.stage === "result") {
      await this.deliver(job);
      return;
    }
    if (job.stage === "running") {
      await this.deliver({
        ...job,
        stage: "result",
        text: this.failure(job.command.model, "检测任务中断，请重新发送指令"),
      });
      return;
    }
    const replyId = await sendTelegramMessage(token, {
      chatId: job.command.chatId,
      messageId: job.command.messageId,
      ...(job.command.messageThreadId === undefined
        ? {}
        : { messageThreadId: job.command.messageThreadId }),
      text: `模型检测中：${job.command.model}...`,
    });
    await this.state.storage.put("job", { ...job, stage: "running", replyId });
    let text: string;
    try {
      const outputs = await Promise.allSettled(
        generateDetectionChallenges().map(async (challenge, probeIndex) => {
          for (let attempt = 0; ; attempt++) {
            try {
              const response = await this.env.CODEX_AUTH.getByName("codex").fetch(
                "https://codex-auth.internal/probe",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ model: job.command.model, prompt: challenge.prompt }),
                },
              );
              if (!response.ok) {
                await response.body?.cancel();
                throw new DetectionError(`Codex 请求失败（HTTP ${response.status}）`);
              }
              const output = probeResponseSchema.parse(await response.json());
              const sample = { text: output.text, expectedCount: challenge.expectedCount };
              const validation = analyzeDetectionOutputs([sample]);
              if (!validation.prediction || validation.validOutputs < 1)
                throw new DetectionError("回答不符合评分要求（数字不足或序列无效）");
              return sample;
            } catch (error) {
              if (!(error instanceof Error) || attempt === PROBE_MAX_RETRIES) throw error;
              console.warn("detection.probe.retry", {
                updateId: job.command.updateId,
                probe: probeIndex + 1,
                retry: attempt + 1,
                reason: error instanceof DetectionError ? error.message : error.name,
              });
            }
          }
        }),
      );
      const samples = [];
      for (const output of outputs) {
        if (output.status === "fulfilled") samples.push(output.value);
      }
      console.info("detection.probes.completed", {
        updateId: job.command.updateId,
        successfulProbes: samples.length,
        failedProbes: outputs.length - samples.length,
      });
      if (samples.length === 0)
        throw new DetectionError("三轮请求均失败（每轮最多重试3次），请稍后重新检测");
      const result = analyzeDetectionOutputs(samples);
      if (result.decision === "not_model")
        throw new DetectionError("回答的数字序列不符合参考库特征，暂不可评分");
      if (!result.prediction || result.validOutputs < 1)
        throw new DetectionError(`有效回答 ${result.validOutputs}/${samples.length}，暂不可评分`);
      const sharedFingerprint = result.prediction === "gpt-6-astra";
      const prediction = sharedFingerprint ? "gpt-6-astra/gpt-6.1-sol" : result.prediction;
      const agreement =
        result.prediction === job.command.model ||
        (sharedFingerprint && job.command.model === "gpt-6.1-sol")
          ? "结果一致"
          : "结果不一致";
      const confidence =
        result.probability === null
          ? ""
          : `\n库内匹配概率：${(result.probability * 100).toFixed(1)}%`;
      text = `输入模型：${job.command.model}\n输出模型：${prediction}\n${agreement}（指纹推断）${confidence}`;
    } catch (error) {
      text = this.failure(
        job.command.model,
        error instanceof DetectionError ? error.message : "检测处理失败，请稍后重新检测",
      );
    }
    const result: Job = { stage: "result", command: job.command, replyId, text };
    await this.state.storage.put("job", result);
    await this.deliver(result);
  }

  private failure(model: string, reason: string): string {
    return `输入模型：${model}\n输出模型：未知\n检测失败：${reason}`;
  }

  private async deliver(job: Extract<Job, { stage: "result" }>): Promise<void> {
    await editTelegramMessage(requiredEnv(this.env, "TELEGRAM_BOT_TOKEN"), {
      chatId: job.command.chatId,
      messageId: job.replyId,
      text: job.text,
    });
    await this.state.storage.put("job", { stage: "done" });
    console.info("detection.delivered", {
      updateId: job.command.updateId,
      messageId: job.replyId,
      text: job.text,
    });
  }
}
