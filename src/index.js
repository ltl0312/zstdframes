import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const K0 = 0x28, K1 = 0xb5, K2 = 0x2f, K3 = 0xfd

/**
 * 在缓冲区里找出所有 zstd 帧的起始偏移。
 * 帧头 magic: 28 B5 2F FD
 */
function findFrameStarts(buf) {
  const starts = []
  const last = buf.length - 4
  for (let i = 0; i <= last; i++) {
    if (buf[i] === K0 && buf[i + 1] === K1 && buf[i + 2] === K2 && buf[i + 3] === K3) {
      starts.push(i)
      i += 3
    }
  }
  return starts
}

/**
 * 逐帧流式读取多帧 zstd 文件。
 *
 * 为什么需要它：node:zlib 的 zstdDecompressSync 只解第一帧并静默返回；
 * createZstdDecompress 流在第二帧处抛 ZSTD_error_prefix_unknown。
 *
 * @param {string | Buffer | Uint8Array} source 文件路径或已读入的缓冲区
 * @param {{ maxMerge?: number }} [opts] maxMerge: 帧头误判时最多向后合并几帧（默认 8）
 * @returns {AsyncGenerator<{index:number, offset:number, byteLength:number, data:Buffer|null, error?:Error}>}
 */
export async function* readFrames(source, opts = {}) {
  const maxMerge = opts.maxMerge ?? 8
  const buf = typeof source === 'string' ? readFileSync(source) : Buffer.from(source.buffer || source, source.byteOffset || 0, source.byteLength ?? source.length)
  const starts = findFrameStarts(buf)

  if (starts.length === 0) return

  let i = 0
  let index = 0
  while (i < starts.length) {
    let merged = 1
    let data = null
    let lastErr = null

    while (i + merged <= starts.length && merged <= maxMerge) {
      const begin = starts[i]
      const end = i + merged < starts.length ? starts[i + merged] : buf.length
      try {
        data = zstdDecompressSync(buf.subarray(begin, end))
        break
      } catch (err) {
        lastErr = err
        merged++
      }
    }

    if (data) {
      const end = i + merged < starts.length ? starts[i + merged] : buf.length
      yield { index, offset: starts[i], byteLength: end - starts[i], data }
      index++
      i += merged
    } else {
      yield { index, offset: starts[i], byteLength: 0, data: null, error: lastErr }
      index++
      i += 1
    }
  }
}

/**
 * 逐行产出解压后的 JSON 对象（适用于 .jsonl.zstd）。
 * 跨帧的行会被正确拼接：帧边界不保证落在换行处。
 */
export async function* readJSONLines(source, opts = {}) {
  let carry = ''
  const onLine = function* (text) {
    const parts = (carry + text).split('\n')
    carry = parts.pop() ?? ''
    for (const line of parts) {
      const t = line.trim()
      if (!t) continue
      try {
        yield JSON.parse(t)
      } catch {
        yield { __parseError: true, raw: t }
      }
    }
  }
  for await (const frame of readFrames(source, opts)) {
    if (!frame.data) {
      yield { __frameError: true, index: frame.index, error: String(frame.error?.message || frame.error) }
      continue
    }
    yield* onLine(frame.data.toString('utf8'))
  }
  const tail = carry.trim()
  if (tail) {
    try {
      yield JSON.parse(tail)
    } catch {
      yield { __parseError: true, raw: tail }
    }
  }
}

/**
 * 统计一个多帧 zstd 文件的基本信息，不保留解压内容。
 */
export async function countFrames(source, opts = {}) {
  let frames = 0, lines = 0, compressed = 0, expanded = 0, failed = 0
  for await (const f of readFrames(source, opts)) {
    frames++
    compressed += f.byteLength
    if (!f.data) { failed++; continue }
    expanded += f.data.length
    for (let i = 0; i < f.data.length; i++) if (f.data[i] === 0x0a) lines++
  }
  return { frames, lines, compressedBytes: compressed, expandedBytes: expanded, failedFrames: failed }
}

export { findFrameStarts }
