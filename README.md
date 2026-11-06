# zstdframes

[![CI](https://github.com/ltl0312/zstdframes/actions/workflows/ci.yml/badge.svg)](https://github.com/ltl0312/zstdframes/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/zstdframes.svg)](https://www.npmjs.com/package/zstdframes)
[![node](https://img.shields.io/node/v/zstdframes.svg)](https://nodejs.org)

Read multi-frame zstd files frame by frame, using Node's built-in `zlib`.

**Node's own zstd API cannot read these files.** This library exists because of that.

```bash
npm i zstdframes
```

```js
import { readFrames, readJSONLines } from 'zstdframes'

for await (const frame of readFrames('session.jsonl.zstd')) {
  console.log(frame.index, frame.byteLength, frame.data) // Buffer
}

// .jsonl.zstd → 直接拿对象，跨帧被切断的行会自动拼回来
for await (const ev of readJSONLines('session.jsonl.zstd')) {
  if (ev.type === 'tool/call') console.log(ev.data.name)
}
```

## The problem

A zstd file can hold many independent *frames* concatenated end to end. Anything that appends-and-compresses on the fly — agent session logs, container logs, event exports — writes files exactly like this: one small frame per flush.

Node reads only the first one.

```js
// silent truncation: returns the first frame only, no error
zstdDecompressSync(fs.readFileSync('session.v4.jsonl.zstd'))
// → 226 bytes, 1 line, out of 23,913 frames

// hard error: throws once it reaches frame #2
fs.createReadStream('session.v4.jsonl.zstd').pipe(z.createZstdDecompress())
// → ZSTD_error_prefix_unknown
```

> **Node version note.** The behaviour above is measured on Node 22.x and 24.12.0. Newer builds (24.22.2 confirmed) decode concatenated frames natively — `zstdDecompressSync` then returns every frame, so the silent-truncation symptom disappears on its own. What does not appear on any version is frame-level access: there is still no way to ask for the frame count, jump to frame *n*, or skip a frame without decoding it. That is what this package provides, and it is why `readFrames` works identically on 22.0 and 24.22.

Measured on a real 116 MiB log (23,913 frames → 587 MiB expanded), Node 24 / i9-13900HX:

| approach | result | time | peak RSS |
|---|---|---|---|
| `zstdDecompressSync` (whole file) | 226 B, 1 line | instant | — |
| `fzstd` (pure JS) | dies at the 512 MB string limit | 14.4 s | ≥615 MB |
| **`zstdframes`** | 23,913 / 23,913 frames | **1.9 s** | **189 MB** |

## Why not just `fzstd`

`fzstd` decodes correctly and is a fine package. It is a pure-JS port of the decompressor, so it is ~7× slower here, and it returns the whole output as a single string — which hits V8's 512 MB string limit on any log over ~512 MB of expanded data. `zstdframes` calls the compiled zstd that ships inside Node and hands you one frame at a time, so memory stays bounded by the largest frame (2.3 MB here), not by the file.

Three things follow from frame-at-a-time:

1. **Bounded memory.** No 512 MB ceiling, no whole-file buffer.
2. **Incremental reads.** Frame boundaries are addressable: remember `index` / `offset`, resume from there next time.
3. **Frame-level recovery.** A corrupt frame is reported and skipped; the rest of the file still reads.

## API

### `readFrames(source, opts?)`

`source`: a file path, or a `Buffer`. Yields `{ index, offset, byteLength, data, error? }`.

`data` is `null` only when a frame could not be decoded; `error` then carries the cause.

`opts.maxMerge` (default `8`) — a frame header can appear by chance inside compressed payload. When a candidate boundary fails to decode, the reader merges forward up to this many frames before giving up on that candidate.

### `readJSONLines(source, opts?)`

Yields parsed objects. Lines split across a frame boundary are joined. Unparseable lines yield `{ __parseError: true, raw }` instead of throwing.

### `countFrames(source, opts?)`

Returns `{ frames, lines, compressedBytes, expandedBytes, failedFrames }` without retaining content.

## CLI

```
zstdframes count <file>            frame/line counts and sizes
zstdframes cat   <file>            all decompressed bytes to stdout
zstdframes json  <file> [--field]  one JSON object per line
zstdframes frame <file> --at <n>   a single frame by index
zstdframes info  <file>            size and frame distribution
```

```console
$ zstdframes count session.v4.jsonl.zstd
frames   23913
lines    46685
compressed  116.2 MB
expanded    587.3 MB
elapsed  1855 ms

$ zstdframes json session.v4.jsonl.zstd --field type | sort | uniq -c | sort -rn | head -3
   6757 "tool/result"
   6709 "tool/call"
   6611 "step/start"
```

## Limits

- Zero runtime dependencies, Node ≥ 22.15 (`node:zlib` zstd support).
- The compressed file is read into memory in one piece. A 116 MiB log is fine; a 4 GiB one is not. Streaming from disk is not implemented in 0.1.0.
- Skippable frames (`0x184D2A5?`) are not recognised; they surface as decode failures unless `maxMerge` happens to swallow them.
- Compression is out of scope. This reads files other software wrote.

## License

MIT
