import { describe, expect, it } from "vitest";
import { analyzeDetectionOutputs, generateDetectionChallenges } from "../src/detector";
import fixture from "../src/detector/reference-fixture.json";

describe("pinned lm-detector", () => {
  it("generates three distinct upstream challenge lengths in the supported range", () => {
    const challenges = generateDetectionChallenges();

    expect(challenges).toHaveLength(3);
    expect(new Set(challenges.map((challenge) => challenge.expectedCount)).size).toBe(3);
    for (const challenge of challenges) {
      expect(challenge.expectedCount).toBeGreaterThanOrEqual(292);
      expect(challenge.expectedCount).toBeLessThanOrEqual(332);
      expect(challenge.prompt.length).toBeGreaterThan(0);
    }
  });

  it("matches the untouched upstream runtime on three recorded reference replies", () => {
    const result = analyzeDetectionOutputs(fixture.samples);

    expect(result.prediction).toBe("claude-haiku-4.5");
    expect(result.probability).toBeCloseTo(0.9999999889341641, 12);
    expect(result.decision).toBe("ranked");
    expect(result.validOutputs).toBe(3);
  });

  it.each([1, 2])("ranks %i recorded reference replies without calibrated confidence", (count) => {
    const result = analyzeDetectionOutputs(fixture.samples.slice(0, count));

    expect(result).toEqual({
      prediction: "claude-haiku-4.5",
      probability: null,
      decision: "partial",
      validOutputs: count,
    });
  });

  it.each([0, 1, 2])("ranks the valid replies when reply %i is invalid", (invalidIndex) => {
    const outputs = fixture.samples.map((sample, index) =>
      index === invalidIndex ? { ...sample, text: "I cannot complete this task." } : sample,
    );

    const result = analyzeDetectionOutputs(outputs);

    expect(result).toEqual({
      prediction: "claude-haiku-4.5",
      probability: null,
      decision: "partial",
      validOutputs: 2,
    });
  });

  it.each([
    { label: "empty", text: "" },
    { label: "refusal", text: "I cannot complete this task." },
    { label: "out of range", text: "999,".repeat(300) },
    { label: "too short", text: "1,".repeat(79) },
  ])("ranks one valid reply while filtering a $label reply", ({ text }) => {
    const outputs = [...fixture.samples.slice(0, 1), { text, expectedCount: 300 }];

    const result = analyzeDetectionOutputs(outputs);

    expect(result).toEqual({
      prediction: "claude-haiku-4.5",
      probability: null,
      decision: "partial",
      validOutputs: 1,
    });
  });

  it.each([0, 1, 2, 3])(
    "stays unscorable with %i invalid replies and no valid replies",
    (count) => {
      const outputs = Array.from({ length: count }, () => ({ text: "", expectedCount: 300 }));

      const result = analyzeDetectionOutputs(outputs);

      expect(result).toEqual({
        prediction: "",
        probability: null,
        decision: "unscorable",
        validOutputs: 0,
      });
    },
  );

  it("stays unscorable with more than three replies", () => {
    const count = 4;
    const outputs = Array.from({ length: count }, (_, index) => fixture.samples[index % 3]).filter(
      (sample) => sample !== undefined,
    );

    const result = analyzeDetectionOutputs(outputs);

    expect(result).toEqual({
      prediction: "",
      probability: null,
      decision: "unscorable",
      validOutputs: count,
    });
  });

  it.each([1, 2, 3])("preserves upstream rejection of %i sorted numeric replies", (count) => {
    const outputs = Array.from({ length: count }, () => ({
      text: Array.from({ length: 300 }, (_, index) => index + 1).join(","),
      expectedCount: 300,
    }));

    const result = analyzeDetectionOutputs(outputs);

    expect(result).toEqual({
      prediction: "",
      probability: null,
      decision: "not_model",
      validOutputs: count,
    });
  });
});
