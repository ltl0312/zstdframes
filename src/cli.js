#!/usr/bin/env node
import { statSync } from 'node:fs'
import { readFrames, readJSONLines, countFrames } from './index.js'

const USAGE = `zstdframes — 读取多帧 zstd 文件

  zstdframes count <file>            帧数 / 行数 / 压缩与解压体积
  zstdframes cat   <file>            输出全部解压内容到 stdout
  zstdframes json  <file> [--field]  逐行输出 JSON（--field 取单字段）
  zstdframes frame <file> --at <n>   只输出第 n 帧（0 起）
  zstdframes info  <file>            文件大小与帧分布

选项: --max-merge <n>  帧头误判时最多合并几帧（默认 8）
`

function parseArgs(argv) {
  const args = { _: [], maxMerge: 8 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--field') args.field = argv[++i]
    else if (a === '--at') args.at = Number(argv[++i])
    else if (a === '--max-merge') args.maxMerge = Number(argv[++i])
    else if (a === '-h' || a === '--help') args.help = true
    else args._.push(a)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const [cmd, file] = args._

if (args.help || !cmd || !file) {
  process.stdout.write(USAGE)
  process.exit(cmd ? 0 : 2)
}

try {
  statSync(file)
} catch {
  process.stderr.write(`no such file: ${file}\n`)
  process.exit(2)
}

const io = { maxMerge: args.maxMerge }

if (cmd === 'count') {
  const t0 = Date.now()
  const r = await countFrames(file, io)
  process.stdout.write(
    `frames   ${r.frames}\n` +
      `lines    ${r.lines}\n` +
      `compressed  ${(r.compressedBytes / 1048576).toFixed(1)} MB\n` +
      `expanded    ${(r.expandedBytes / 1048576).toFixed(1)} MB\n` +
      (r.failedFrames ? `failed    ${r.failedFrames}\n` : '') +
      `elapsed  ${Date.now() - t0} ms\n`,
  )
} else if (cmd === 'cat') {
  for await (const f of readFrames(file, io)) {
    if (f.data) process.stdout.write(f.data)
    else process.stderr.write(`frame ${f.index}: ${f.error?.message}\n`)
  }
} else if (cmd === 'json') {
  for await (const obj of readJSONLines(file, io)) {
    if (obj && obj.__parseError) {
      process.stderr.write(`bad json: ${obj.raw.slice(0, 120)}\n`)
      continue
    }
    if (obj && obj.__frameError) {
      process.stderr.write(`frame ${obj.index}: ${obj.error}\n`)
      continue
    }
    process.stdout.write((args.field ? JSON.stringify(obj[args.field] ?? null) : JSON.stringify(obj)) + '\n')
  }
} else if (cmd === 'frame') {
  const at = args.at ?? 0
  for await (const f of readFrames(file, io)) {
    if (f.index === at) {
      if (f.data) process.stdout.write(f.data)
      else process.stderr.write(`frame ${f.index} failed: ${f.error?.message}\n`)
      break
    }
  }
} else if (cmd === 'info') {
  let i = 0, maxF = 0, minF = Infinity, sum = 0
  for await (const f of readFrames(file, io)) {
    const n = f.data ? f.data.length : 0
    if (n > maxF) maxF = n
    if (n < minF) minF = n
    sum += n
    i++
  }
  process.stdout.write(
    `file      ${file}\n` +
      `size      ${(statSync(file).size / 1048576).toFixed(1)} MB\n` +
      `frames    ${i}\n` +
      `frame avg ${(sum / (i || 1) / 1024).toFixed(1)} KB  min ${(minF / 1024).toFixed(1)} KB  max ${(maxF / 1024).toFixed(1)} KB\n`,
  )
} else {
  process.stderr.write(`unknown command: ${cmd}\n\n` + USAGE)
  process.exit(2)
}
