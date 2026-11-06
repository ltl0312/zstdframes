export interface Frame {
  index: number
  offset: number
  byteLength: number
  data: Buffer | null
  error?: Error
}

export interface ReadOptions {
  /** 帧头误判时最多向后合并几帧，默认 8 */
  maxMerge?: number
}

export interface FrameStats {
  frames: number
  lines: number
  compressedBytes: number
  expandedBytes: number
  failedFrames: number
}

export function readFrames(
  source: string | Buffer | Uint8Array,
  opts?: ReadOptions,
): AsyncGenerator<Frame>

export function readJSONLines(
  source: string | Buffer | Uint8Array,
  opts?: ReadOptions,
): AsyncGenerator<any>

export function countFrames(
  source: string | Buffer | Uint8Array,
  opts?: ReadOptions,
): Promise<FrameStats>

export function findFrameStarts(buf: Buffer | Uint8Array): number[]
