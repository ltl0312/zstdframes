import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { readFrames, readJSONLines, countFrames, findFrameStarts } from '../src/index.js'

/** 造一个多帧 zstd 缓冲区：每段独立压缩后首尾相接 */
function makeMultiFrame(parts) {
  return Buffer.concat(parts.map((p) => zstdCompressSync(Buffer.from(p, 'utf8'))))
}

test('Node 内置同步 API 在多帧文件上只返回第一帧（本包存在的原因）', () => {
  const buf = makeMultiFrame(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'])
  const native = zstdDecompressSync(buf).toString('utf8')
  assert.equal(native, '{"a":1}\n')
})

test('findFrameStarts 找到全部帧头', () => {
  const buf = makeMultiFrame(['x', 'y', 'z', 'w'])
  assert.equal(findFrameStarts(buf).length, 4)
})

test('readFrames 逐帧产出，且顺序与内容正确', async () => {
  const buf = makeMultiFrame(['alpha', 'beta', 'gamma'])
  const got = []
  for await (const f of readFrames(buf)) {
    assert.equal(f.index, got.length)
    assert.ok(f.data instanceof Buffer)
    got.push(f.data.toString('utf8'))
  }
  assert.deepEqual(got, ['alpha', 'beta', 'gamma'])
})

test('readFrames 的 offset + byteLength 能重新切回原始帧', async () => {
  const buf = makeMultiFrame(['one', 'two', 'three'])
  for await (const f of readFrames(buf)) {
    const slice = buf.subarray(f.offset, f.offset + f.byteLength)
    assert.equal(zstdDecompressSync(slice).toString('utf8'), f.data.toString('utf8'))
  }
})

test('readJSONLines 跨帧拼接被切断的行', async () => {
  // 一行 JSON 在帧边界处被劈开：帧1 不带换行，帧2 才把这一行收尾
  const buf = makeMultiFrame(['{"name":"流萤","age":', '24}\n{"name":"开拓者"}\n'])
  const rows = []
  for await (const o of readJSONLines(buf)) rows.push(o)
  assert.deepEqual(rows, [
    { name: '流萤', age: 24 },
    { name: '开拓者' },
  ])
})

test('中间帧损坏时其余帧仍可读', async () => {
  const good1 = zstdCompressSync(Buffer.from('keep-1'))
  const good2 = zstdCompressSync(Buffer.from('keep-2'))
  const broken = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00])
  const buf = Buffer.concat([good1, broken, good2])
  const out = []
  for await (const f of readFrames(buf, { maxMerge: 1 })) {
    out.push(f.data ? f.data.toString('utf8') : `<err ${f.index}>`)
  }
  assert.ok(out.includes('keep-1'), '第一帧应可读')
  assert.ok(out.includes('keep-2'), '损坏帧之后的帧应可读')
})

test('countFrames 统计帧数、行数与体积', async () => {
  const buf = makeMultiFrame(['a\nb\n', 'c\n'])
  const r = await countFrames(buf)
  assert.equal(r.frames, 2)
  assert.equal(r.lines, 3)
  assert.equal(r.expandedBytes, 6)
  assert.equal(r.failedFrames, 0)
})

test('空缓冲区不产出任何帧', async () => {
  const got = []
  for await (const f of readFrames(Buffer.alloc(0))) got.push(f)
  assert.equal(got.length, 0)
})
