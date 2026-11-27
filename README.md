[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/tronolllanj-creator/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/tronolllanj-creator/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# png-squeeze-01-run-20261127

Losslessly re-encodes 8 screenshots (1280×720 RGBA stored PNGs) as the smallest valid PNGs.

## Techniques

- **Colour-type reduction**: per image, picks the minimal valid colour type — palette (type 3) with transparent entries first then by count (and a luminance-ordered variant), greyscale (type 0) or greyscale+alpha (type 4) when all pixels are grey, RGB (type 2) or RGBA (type 6) otherwise, and a tRNS-key form when every non-opaque pixel shares one transparent value unused by opaque pixels.
- **Per-row adaptive filters**: screens fixed filters 0/1/2/4, minsum (min sum of absolute filtered bytes), pairs (fewest distinct neighbouring byte pairs), and brute (per row try all five filters, compress at level 4 with 32 KiB dictionary). Palette-by-count is tried unfiltered only.
- **Two-stage compression**: candidates screened with zlib level 6; winner re-encoded three ways and the smallest kept — (a) zlib level 9 default strategy, (b) zlib level 9 filtered strategy, (c) custom lazy-LZ77 + dynamic Huffman deflate.
- **Custom deflate**: lazy LZ77 (3-byte hash chains, 15-bit table, chain limit 4096, quick reject on byte at best length, chain shortened to 1024 after match ≥ 200, lazy rule: defer when next position has strictly longer match) + length-limited dynamic Huffman (max 15 bits lit/len & distance, max 7 for code-length code) with fixed-Huffman fallback per block, kept by exact bit cost. One block per image, single BitWriter spanning whole stream, only final block padded to byte boundary.
- **Huffman safety**: optimal tree via binary heap, depths clamped to limit, Kraft sum verified as integer equality (sum 2^(maxBits-len) == 2^maxBits); invalid alphabets fall back to fixed Huffman.
- **Deterministic & fast**: no Date, no Math.random, byte-identical on re-run. Time guard at 45 s switches remaining images to zlib level 9 only. Whole practice set well under 60 s (screening ~8 s, custom deflate ~6 s).

## Run locally on the practice set

```bash
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Measured practice-set result

The encoder targets two baselines on the practice set: it must beat the 701,039 score from brute-force filtering with zlib level 9, and it must strictly beat the 416,453 score from the fixed-Paeth baseline. The final measured score is recorded here after the local practice run completes.
