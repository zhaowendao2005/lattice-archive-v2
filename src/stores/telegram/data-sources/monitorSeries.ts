/**
 * ============================================================================
 * 运行监控时间序列（纯函数 + 分块列式存储，无 DOM / 无 Vue）
 * ============================================================================
 * 1. 所有曲线数据完整保留在内存中，不设时间窗上限；「清空」按钮是唯一的丢弃路径。
 * 2. 存储按块（chunk）增长：每块时间一列 + 每条总线 × 每个指标一列，追加 O(1)。
 * 3. 绘图时按像素桶做 min/max 降采样，桶内同时保留最小与最大，短暂尖峰不会被抽掉。
 * 4. 指标量纲分离（并发数 / 请求每秒 / 字节每秒），绝不放进同一坐标轴。
 */

/** 与 contracts/monitor.ts 的 MONITOR_BUSES 顺序一致；此处独立声明以保持本模块可离线测试。 */
export const SERIES_BUSES = [
  'search', 'cover', 'mediaAsset', 'stream', 'chatRead', 'chatCommand', 'bot', 'vault', 'account',
] as const;
export type SeriesBus = (typeof SERIES_BUSES)[number];

export type SeriesMetric = 'concurrency' | 'requests' | 'throughput';
export const SERIES_METRICS: readonly SeriesMetric[] = ['concurrency', 'requests', 'throughput'];

export interface BusSample {
  concurrency: number;
  requests: number;
  throughput: number;
}

export interface LaneRateInput {
  lane: string;
  bus: string;
  active: number;
  okRate: number;
  errorRate: number;
  cancelledRate: number;
  bytesRate: number;
}

const BUS_COUNT = SERIES_BUSES.length;
const CHUNK_SIZE = 4096;

/**
 * 按总线聚合一个采样帧：
 * - 并发排除 fullMedia（它是「同时下载的文件数」，与 mediaPart 的 RPC 数相加会重复计数）；
 * - 请求速率取终态计数器（成功 + 失败 + 取消）的帧差，再按总线求和；
 * - 字节吞吐只统计应用层显式 addBytes 的下载字节。
 */
export function aggregateBuses(lanes: readonly LaneRateInput[]): Record<SeriesBus, BusSample> {
  const out = Object.fromEntries(SERIES_BUSES.map((bus) => [bus, { concurrency: 0, requests: 0, throughput: 0 }])) as Record<SeriesBus, BusSample>;
  for (const lane of lanes) {
    const target = out[lane.bus as SeriesBus];
    if (!target) continue;
    if (lane.lane !== 'fullMedia') target.concurrency += lane.active;
    target.requests += Math.max(0, lane.okRate) + Math.max(0, lane.errorRate) + Math.max(0, lane.cancelledRate);
    target.throughput += Math.max(0, lane.bytesRate);
  }
  return out;
}

export function emptySample(): Record<SeriesBus, BusSample> {
  return Object.fromEntries(SERIES_BUSES.map((bus) => [bus, { concurrency: 0, requests: 0, throughput: 0 }])) as Record<SeriesBus, BusSample>;
}

export type TimedPoints = Array<[number, number]>;
export type SeriesByBus = Record<SeriesBus, TimedPoints>;

interface SeriesChunk {
  time: Float64Array;
  columns: Record<SeriesMetric, Float32Array[]>;
  length: number;
}

function createChunk(): SeriesChunk {
  const columns = {
    concurrency: Array.from({ length: BUS_COUNT }, () => new Float32Array(CHUNK_SIZE)),
    requests: Array.from({ length: BUS_COUNT }, () => new Float32Array(CHUNK_SIZE)),
    throughput: Array.from({ length: BUS_COUNT }, () => new Float32Array(CHUNK_SIZE)),
  };
  return { time: new Float64Array(CHUNK_SIZE), columns, length: 0 };
}

function emptyPoints(): SeriesByBus {
  return Object.fromEntries(SERIES_BUSES.map((bus) => [bus, [] as TimedPoints])) as SeriesByBus;
}

/** 归并两个已按时间排序的点列；同一时间戳优先取分辨率更高的一方（b）。 */
export function mergeTimedPoints(a: TimedPoints, b: TimedPoints): TimedPoints {
  const out: TimedPoints = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [ta] = a[i]!;
    const [tb] = b[j]!;
    if (ta < tb) { out.push(a[i++]!); }
    else if (tb < ta) { out.push(b[j++]!); }
    else { out.push(b[j++]!); i++; }
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

export class MonitorSeriesStore {
  private chunks: SeriesChunk[] = [createChunk()];
  private samples = 0;

  get size(): number { return this.samples; }

  /** 预留内存估算（字节）：只按已分配的块计算，不含未触达的容量。 */
  estimateBytes(): number {
    const perSample = 8 + BUS_COUNT * 4 * SERIES_METRICS.length;
    return this.chunks.length * CHUNK_SIZE * perSample;
  }

  clear(): void {
    this.chunks = [createChunk()];
    this.samples = 0;
  }

  firstTime(): number {
    const chunk = this.chunks[0];
    return chunk && chunk.length ? chunk.time[0]! : 0;
  }

  latestTime(): number {
    const chunk = this.chunks[this.chunks.length - 1];
    return chunk && chunk.length ? chunk.time[chunk.length - 1]! : 0;
  }

  append(at: number, sample: Record<SeriesBus, BusSample>): void {
    let chunk = this.chunks[this.chunks.length - 1]!;
    if (chunk.length >= CHUNK_SIZE) {
      chunk = createChunk();
      this.chunks.push(chunk);
    }
    const index = chunk.length++;
    chunk.time[index] = at;
    for (const metric of SERIES_METRICS) {
      const columns = chunk.columns[metric];
      for (let bus = 0; bus < BUS_COUNT; bus += 1) {
        columns[bus]![index] = sample[SERIES_BUSES[bus]!]?.[metric] ?? 0;
      }
    }
    this.samples += 1;
  }

  /**
   * 在 [start, end] 上按桶降采样。每个桶、每条总线保留最小与最大两个点（按真实时间排序），
   * 因此尖峰不会像简单抽点那样消失；点数上限约为 bucketCount × 2 × 总线数。
   */
  buildSeries(metric: SeriesMetric, start: number, end: number, buckets: number): SeriesByBus {
    const result = emptyPoints();
    if (!(end > start) || buckets <= 0) return result;
    const bucketCount = Math.max(1, Math.floor(buckets));
    const width = (end - start) / bucketCount;
    const cellCount = bucketCount * BUS_COUNT;
    const min = new Float32Array(cellCount).fill(Infinity);
    const max = new Float32Array(cellCount).fill(-Infinity);
    const minTime = new Float64Array(cellCount);
    const maxTime = new Float64Array(cellCount);
    let seen = 0;

    for (const chunk of this.chunks) {
      // 块内时间单调递增，可整块跳过不相交的数据。
      if (chunk.length === 0) continue;
      if (chunk.time[chunk.length - 1]! < start) continue;
      if (chunk.time[0]! > end) break;
      const column = chunk.columns[metric];
      for (let index = 0; index < chunk.length; index += 1) {
        const time = chunk.time[index]!;
        if (time < start || time > end) continue;
        const bucket = Math.min(bucketCount - 1, Math.floor((time - start) / width));
        seen += 1;
        for (let bus = 0; bus < BUS_COUNT; bus += 1) {
          const value = column[bus]![index]!;
          const cell = bucket * BUS_COUNT + bus;
          if (value < min[cell]!) { min[cell] = value; minTime[cell] = time; }
          if (value > max[cell]!) { max[cell] = value; maxTime[cell] = time; }
        }
      }
    }
    if (!seen) return result;

    for (let bus = 0; bus < BUS_COUNT; bus += 1) {
      const points = result[SERIES_BUSES[bus]!];
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const cell = bucket * BUS_COUNT + bus;
        const low = min[cell]!;
        if (!Number.isFinite(low)) continue;
        const high = max[cell]!;
        const lowAt = minTime[cell]!;
        const highAt = maxTime[cell]!;
        if (lowAt === highAt || low === high) {
          points.push([lowAt, low]);
        } else if (lowAt < highAt) {
          points.push([lowAt, low], [highAt, high]);
        } else {
          points.push([highAt, high], [lowAt, low]);
        }
      }
    }
    return result;
  }
}
