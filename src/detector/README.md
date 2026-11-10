# Pinned lm-detector inference

Source: [Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector/tree/d1b86a7c54d3c49ca37b34d439e7fcd5009a9df5),
commit `d1b86a7c54d3c49ca37b34d439e7fcd5009a9df5`, MIT (see LICENSE).

`vendor/challenge-browser.js` and `vendor/fingerprint-core.js` come from upstream
`shared/`. `vendor/positional.js`, `vendor/shared-detector.js`, and
`vendor/detector-codec.js` are type-erased from the corresponding upstream `.ts`
files using the installed Vite 8 OXC transformer with target `es2022`.
All five are formatted with repository Biome. The sole control-flow adjustment is
a block-bodied nested `forEach` in positional.js, discarding its already-unused
return value to satisfy Biome. Numerical operations and upstream decisions are
preserved. The vendor files deliberately retain upstream module boundaries and
size for auditability. Handwritten `.d.ts` files describe the inference surface
consumed here, replacing the unrelated upstream `types.ts` API/transport types.
The upstream sources, including `types.ts`, were read from the pinned archive.

`shared_detector.bin` is the unmodified 4,949,828-byte upstream
`data/shared_detector.bin`. `bank.json` projects `data/unified_bank.json` to
`built_at` and each model's `id`, `display_name`, `family`, `family_name`, and
`response_count`, preserving order and all 68 models, including `gpt-5.6-luna`.
The upstream compatibility check binds this metadata to the artifact.

The wrapper generates exactly three upstream challenges, adapts `expectedCount`
to `expected_count`, and never enables partial analysis or retries. Upstream
acceptance requires at least max(80, ceil(expected_count * 0.55)) parsed numbers;
it does not require the requested count exactly. Any rejected reply or a total
other than three yields `unscorable`. Upstream successful rankings have no
`decision` field; the wrapper calls that result `ranked`. `not_model` is preserved.
The probability is a calibrated relative probability within this reference bank,
and does not prove model identity or account for models outside the bank.

The binary uses Vite's `?url&inline` data-URL asset import, declared in `assets.d.ts`.
It is bundled offline and base64-decoded only on the first analysis. The decoded
artifact is cached in module scope. No inference request or runtime data fetch
is made. This module adds no dependencies or toolchain configuration.

## Independent reference proof

`reference-fixture.json` contains the exact text, requested counts, and sample IDs
of the first three samples in the first record of pinned
`data/unified_reference.jsonl` (`migration-362ecb2748d8fd93bb5e8faf`). These are
recorded reference replies, not an independent held-out accuracy evaluation.
Their source model is `claude-haiku-4.5`.

Before running the wrapper, Vite's `ssrLoadModule` loaded the untouched upstream
`shared/shared-detector.ts` and `shared/detector-codec.ts` from the downloaded
archive. Calling `analyzeSharedOutputs` on the original samples with the full
original bank and binary produced:

```json
{
  "prediction": "claude-haiku-4.5",
  "probability": 0.9999999889341641,
  "used_outputs": 3
}
```

The successful upstream result omits `decision`. The test pins its winner and
probability independently of the wrapper. Artifact binding reported by that run:

- base SHA-256: `da0311bd1e2596cdb4532bffbceb70b437d484834a60cbfe7cd8235cb9d1151b`
- reference SHA-256: `59976f055b7ff6d78a17c32488b4bb33fb8bdfc66f0885befb9f05d811cd3ce0`

Local verification uses repository Biome, strict `tsc --noEmit`, Vitest, and Vite.
Parent integration owns transport, Telegram, Durable Objects, and configuration.
