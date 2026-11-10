import type { SharedDetector } from "./shared-detector";

export function decodeDetector(data: Uint8Array): SharedDetector;
export function encodeDetector(artifact: SharedDetector): Uint8Array;
