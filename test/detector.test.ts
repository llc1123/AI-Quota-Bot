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

  it.each([0, 1, 2])("stays unscorable when reply %i is invalid", (invalidIndex) => {
    const outputs = fixture.samples.map((sample, index) =>
      index === invalidIndex ? { ...sample, text: "I cannot complete this task." } : sample,
    );

    const result = analyzeDetectionOutputs(outputs);

    expect(result).toEqual({
      prediction: "",
      probability: null,
      decision: "unscorable",
      validOutputs: 2,
    });
  });

  it.each([0, 1, 2, 4])("requires exactly three replies rather than %i", (count) => {
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

  it("preserves the upstream rejection of sorted numeric output", () => {
    const outputs = Array.from({ length: 3 }, () => ({
      text: Array.from({ length: 300 }, (_, index) => index + 1).join(","),
      expectedCount: 300,
    }));

    const result = analyzeDetectionOutputs(outputs);

    expect(result).toEqual({
      prediction: "",
      probability: null,
      decision: "not_model",
      validOutputs: 3,
    });
  });
});
