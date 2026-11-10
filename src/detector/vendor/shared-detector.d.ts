type Vector = readonly number[];
type Matrix = readonly Vector[];
type Preprocessing = readonly { readonly mean: Vector; readonly scale: Vector }[];
type FeatureBank = {
  readonly feature_mean: Vector;
  readonly feature_scale: Vector;
  readonly nuisance_basis: Matrix;
  readonly centroids: Matrix;
};

export interface SharedDetector {
  readonly schema: "shared-detector-v2";
  readonly source_run: string;
  readonly base_sha256: string;
  readonly source_reference_sha256: string;
  readonly bank_built_at: string;
  readonly model_ids: readonly string[];
  readonly response_counts: Vector;
  readonly calibration_sha256?: string | null;
  readonly calibration?: {
    readonly schema: "shared-confidence-v2";
    readonly method: "ranking-temperature";
    readonly tau: number;
    readonly binding: {
      readonly base_sha256: string;
      readonly reference_sha256: string;
      readonly model_ids: readonly string[];
    };
    readonly calibration_run: string;
  } | null;
  readonly ranker: {
    readonly head_params: Preprocessing;
    readonly full_params: Preprocessing;
    readonly lda_weights: Matrix;
    readonly lda_bias: Vector;
    readonly references: readonly Matrix[];
    readonly bank: {
      readonly hellinger: FeatureBank;
      readonly ordered_blocks: FeatureBank & { readonly environment_centroids: readonly Matrix[] };
    };
    readonly blend: { readonly frequency: number; readonly positional: number };
    readonly positional: {
      readonly params: Preprocessing;
      readonly weights: Matrix;
      readonly bias: Vector;
    };
  };
}

interface Bank {
  readonly built_at: string;
  readonly models: readonly {
    readonly id: string;
    readonly display_name: string;
    readonly family: string;
    readonly family_name: string;
    readonly response_count: number;
  }[];
}

export function analyzeSharedOutputs(
  outputs: readonly { readonly text: string; readonly expected_count: number }[],
  bank: Bank,
  artifact: SharedDetector,
): {
  readonly prediction: string;
  readonly probability: number | null;
  readonly decision?: "unscorable" | "not_model";
  readonly used_outputs: number;
};
