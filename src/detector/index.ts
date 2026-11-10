import bank from "./bank.json";
import detectorDataUrl from "./shared_detector.bin?url&inline";
import { generateChallenges } from "./vendor/challenge-browser.js";
import { decodeDetector } from "./vendor/detector-codec.js";
import { analyzeSharedOutputs, type SharedDetector } from "./vendor/shared-detector.js";

export interface DetectionChallenge {
  readonly prompt: string;
  readonly expectedCount: number;
}

export interface DetectionResult {
  readonly prediction: string;
  readonly probability: number | null;
  readonly decision: string;
  readonly validOutputs: number;
}

// Decode only on the first analysis and reuse the frozen upstream parameters.
let detector: SharedDetector | undefined;

export function generateDetectionChallenges(): readonly DetectionChallenge[] {
  return generateChallenges(3).map(({ prompt, expected_count }) => ({
    prompt,
    expectedCount: expected_count,
  }));
}

export function analyzeDetectionOutputs(
  outputs: readonly { readonly text: string; readonly expectedCount: number }[],
): DetectionResult {
  if (!detector) {
    // Vite's inline asset is a base64 data URL, so no runtime request is needed.
    const encoded = detectorDataUrl.slice(detectorDataUrl.indexOf(",") + 1);
    detector = decodeDetector(Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0)));
  }
  const result = analyzeSharedOutputs(
    outputs.map(({ text, expectedCount }) => ({ text, expected_count: expectedCount })),
    bank,
    detector,
  );
  return {
    prediction: result.prediction,
    probability: result.probability,
    decision: result.decision ?? "ranked",
    validOutputs: result.used_outputs,
  };
}
