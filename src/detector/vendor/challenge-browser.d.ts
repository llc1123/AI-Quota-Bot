export function generateChallenges(
  count?: number,
  usedLengths?: readonly number[],
): { readonly id: string; readonly expected_count: number; readonly prompt: string }[];
