import { createLogger } from '../../lib/logger';

/**
 * Soroban resource consumption sentinel (#720).
 *
 * Analyzes Soroban transaction diagnostic events to detect when contract
 * invocations are approaching resource limits. Diagnostic events expose
 * resource metering (CPU instructions and memory/RAM) from the VM execution
 * trace. We compute usage percentages against Soroban ledger transaction
 * limits and emit a warning when either exceeds a configurable threshold
 * (default 85%).
 */

export const DEFAULT_RESOURCE_USAGE_THRESHOLD = 0.85;

export interface SorobanResourceMetrics {
  /** CPU instructions used during contract execution. */
  cpuInstructions?: number | string | bigint;
  /** Memory (RAM) bytes consumed during execution. */
  memoryBytes?: number | string | bigint;
  /** Maximum CPU instructions allowed by ledger/tx limits for this context. */
  cpuLimit?: number | string | bigint;
  /** Maximum memory bytes allowed by ledger/tx limits for this context. */
  memoryLimit?: number | string | bigint;
}

export interface ResourceUsagePercentages {
  cpuPercent: number | null;
  memoryPercent: number | null;
  cpuUsed: number;
  cpuLimit: number;
  memoryUsed: number;
  memoryLimit: number;
}

export interface ResourceConsumptionAssessment {
  hasData: boolean;
  cpuPercent: number | null;
  memoryPercent: number | null;
  cpuUsed: number;
  cpuLimit: number;
  memoryUsed: number;
  memoryLimit: number;
  threshold: number;
  exceedsThreshold: boolean;
  exceededMetric: 'cpu' | 'memory' | 'both' | null;
  message: string;
}

export interface ResourceSentinelOptions {
  threshold?: number;
  /** Maximum numbers to clamp limits/usage to (avoid Infinity). */
  maxSafeLimit?: number;
}

const log = createLogger({ module: 'ResourceConsumptionSentinel' });

/**
 * Returns the first candidate that resolves to a positive number, or
 * undefined when none of them carry a usable limit.
 */
function firstPositiveNumber(candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const n = toNumber(candidate);
    if (n !== null && n > 0) return n;
  }
  return undefined;
}

/**
 * Normalizes a resource counter that may arrive as a number, bigint or
 * (very large) numeric string into a safe JS number. Returns null when the
 * value is missing or not numeric.
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function computeResourcePercentages(
  metrics: SorobanResourceMetrics,
  maxSafeLimit = Number.MAX_SAFE_INTEGER / 2,
): ResourceUsagePercentages {
  const cpuUsed = toNumber(metrics.cpuInstructions) ?? 0;
  let cpuLimit = toNumber(metrics.cpuLimit) ?? 0;
  const memoryUsed = toNumber(metrics.memoryBytes) ?? 0;
  let memoryLimit = toNumber(metrics.memoryLimit) ?? 0;

  if (cpuLimit > maxSafeLimit) cpuLimit = maxSafeLimit;
  if (memoryLimit > maxSafeLimit) memoryLimit = maxSafeLimit;

  const cpuPercent = cpuLimit > 0 ? (cpuUsed / cpuLimit) * 100 : null;
  const memoryPercent = memoryLimit > 0 ? (memoryUsed / memoryLimit) * 100 : null;

  return {
    cpuPercent,
    memoryPercent,
    cpuUsed: cpuUsed >= 0 ? cpuUsed : 0,
    cpuLimit: cpuLimit >= 0 ? cpuLimit : 0,
    memoryUsed: memoryUsed >= 0 ? memoryUsed : 0,
    memoryLimit: memoryLimit >= 0 ? memoryLimit : 0,
  };
}

/**
 * Extracts CPU and memory usage metrics from Soroban transaction diagnostic
 * events or from a result/meta object. Accepts raw XDR strings, parsed objects,
 * or typical Stellar SDK result shapes.
 */
export function extractResourceMetricsFromDiagnosticEvents(
  source: unknown,
): SorobanResourceMetrics {
  const metrics: SorobanResourceMetrics = {};

  if (source == null) return metrics;

  // Try to unwrap common structures
  const candidates: unknown[] = [source];
  if (typeof source === 'string') {
    try {
      candidates.push(JSON.parse(source));
    } catch {}
  }

  // Stellar SDK RPC simulation result? has events/diagnosticEvents
  for (const c of candidates) {
    const obj = c as any;
    // Direct diagnosticEvents array
    const diagArr = obj?.diagnosticEvents ?? obj?.diagnostic_events ?? obj?.diagnosticEventsXdr ?? obj?.events;
    if (Array.isArray(diagArr)) {
      // Sum core metrics from diagnostic events if present
      let cpuSum = 0;
      let memSum = 0;
      for (const d of diagArr) {
        const m = extractCoreMetricsFromEvent(d);
        const c = Number(m.cpuInstructions ?? 0);
        const mm = Number(m.memoryBytes ?? 0);
        if (c > 0) cpuSum += c;
        if (mm > 0) memSum += mm;
      }
      if (cpuSum > 0) metrics.cpuInstructions = metrics.cpuInstructions ?? cpuSum;
      if (memSum > 0) metrics.memoryBytes = metrics.memoryBytes ?? memSum;
    }

    // TransactionMetaV3 with sorobanMeta
    const meta = obj?.resultMeta ?? obj?.resultMetaXdr ?? obj?.meta;
    if (meta) {
      // Try to parse if string
      let parsedMeta: any = meta;
      if (typeof meta === 'string') {
        try {
          // Try XDR base64 → SDK object? But we don't parse deeply here; skip
        } catch {}
      }
      const sorobanMeta = parsedMeta?.v3?.().sorobanMeta?.() ?? parsedMeta?.sorobanMeta ?? parsedMeta?.soroban_meta;
      if (sorobanMeta) {
        const ext = sorobanMeta.ext?.();
        // ext.v1() sometimes contains resource fees; not direct CPU/mem counts
        // diagnosticEvents often under sorobanMeta
        const sDiag = sorobanMeta.diagnosticEvents ?? sorobanMeta.diagnostic_events;
        if (Array.isArray(sDiag)) {
          let cpuSum = 0;
          let memSum = 0;
          for (const d of sDiag) {
            const m = extractCoreMetricsFromEvent(d);
            const c = Number(m.cpuInstructions ?? 0);
            const mm = Number(m.memoryBytes ?? 0);
            if (c > 0) cpuSum += c;
            if (mm > 0) memSum += mm;
          }
          if (cpuSum > 0) metrics.cpuInstructions = metrics.cpuInstructions ?? cpuSum;
          if (memSum > 0) metrics.memoryBytes = metrics.memoryBytes ?? memSum;
        }
      }
    }

    // ── Limits ────────────────────────────────────────────────────────────
    // Distinguish the *declared* resources of a transaction (the caps the
    // signer reserved) from a `resources` blob that only reports what was
    // actually consumed. Only declared limits make sense as a denominator:
    // using consumed footprint bytes as a "limit" produces meaningless
    // percentages.
    const declaredResources =
      obj?.transactionData?.resources ?? obj?.sorobanData?.resources;
    const reportedResources = obj?.resources;
    const config = obj?.ledgerHeader ?? obj?.configSettingContractComputeV0 ?? obj?.config;

    metrics.cpuLimit =
      metrics.cpuLimit ??
      firstPositiveNumber([
        declaredResources?.instructions,
        declaredResources?.maxInstructions,
        declaredResources?.txMaxInstructions,
        reportedResources?.instructions,
        reportedResources?.maxInstructions,
        reportedResources?.cpuLimit,
        reportedResources?.txMaxInstructions,
        obj?.cpuLimit,
        obj?.txMaxInstructions,
        obj?.ledgerMaxInstructions,
        obj?.limits?.cpu,
        config?.txMaxInstructions,
        config?.ledgerMaxInstructions,
      ]);

    metrics.memoryLimit =
      metrics.memoryLimit ??
      firstPositiveNumber([
        obj?.txMemoryLimit,
        obj?.memoryLimit,
        obj?.limits?.memory,
        obj?.sorobanData?.txMemoryLimit,
        declaredResources?.writeBytes,
        declaredResources?.memoryBytes,
        declaredResources?.memoryLimit,
        declaredResources?.txMemoryLimit,
        config?.txMemoryLimit,
        config?.memoryLimit,
      ]);
  }

  // Also scan nested objects for flat resource metrics
  const flatCpu =
    (source as any)?.cpuInstructions ??
    (source as any)?.cpuInsns ??
    (source as any)?.instructions ??
    (source as any)?.cpuUsed ??
    (source as any)?.totalCpuInsns ??
    (source as any)?.totalCpuInstructions;
  const flatMem =
    (source as any)?.memoryBytes ??
    (source as any)?.memBytes ??
    (source as any)?.memory ??
    (source as any)?.memoryUsed ??
    (source as any)?.ramBytes ??
    (source as any)?.totalMemBytes ??
    (source as any)?.mem;
  if (flatCpu != null && metrics.cpuInstructions === undefined) metrics.cpuInstructions = flatCpu;
  if (flatMem != null && metrics.memoryBytes === undefined) metrics.memoryBytes = flatMem;

  return metrics;
}

function extractCoreMetricsFromEvent(event: unknown): SorobanResourceMetrics {
  const m: SorobanResourceMetrics = {};
  if (event == null) return m;
  const e = event as any;

  // Common fields: core_metrics, cpu, mem, cpuInstructions, cpu_insns, instructions, etc.
  const core =
    e?.coreMetrics ??
    e?.core_metrics ??
    e?.metrics ??
    e?.metric ??
    e?.event?.coreMetrics ??
    e?.event?.core_metrics;

  if (core) {
    m.cpuInstructions = core.cpuInstructions ?? core.cpu_insns ?? core.instructions ?? core.cpu ?? core.totalCpuInsns;
    m.memoryBytes = core.memoryBytes ?? core.memBytes ?? core.memory ?? core.ramBytes ?? core.totalMemBytes;
  }

  // Some SDKs put values directly on diagnostic event
  m.cpuInstructions = m.cpuInstructions ?? e?.cpuInstructions ?? e?.cpuInsns ?? e?.instructions ?? e?.cpu ?? e?.totalCpuInsns;
  m.memoryBytes = m.memoryBytes ?? e?.memoryBytes ?? e?.memBytes ?? e?.memory ?? e?.totalMemBytes;

  return m;
}

export class ResourceConsumptionSentinel {
  private readonly threshold: number;
  private readonly maxSafeLimit: number;

  constructor(options: ResourceSentinelOptions = {}) {
    const t = options.threshold ?? DEFAULT_RESOURCE_USAGE_THRESHOLD;
    this.threshold = Number.isFinite(t) && t > 0 && t <= 2 ? t : DEFAULT_RESOURCE_USAGE_THRESHOLD;
    this.maxSafeLimit = options.maxSafeLimit ?? Number.MAX_SAFE_INTEGER / 4;
  }

  public getThreshold(): number {
    return this.threshold;
  }

  /**
   * Assesses resource consumption from diagnostic events and returns a
   * structured assessment, including whether usage exceeds the threshold.
   */
  public assess(source: unknown): ResourceConsumptionAssessment {
    const raw = extractResourceMetricsFromDiagnosticEvents(source);
    const pct = computeResourcePercentages(raw, this.maxSafeLimit);

    const hasData =
      (pct.cpuLimit > 0 || pct.memoryLimit > 0) &&
      ((pct.cpuUsed > 0 && pct.cpuLimit > 0) || (pct.memoryUsed > 0 && pct.memoryLimit > 0));

    const exceededCpu = pct.cpuPercent != null && pct.cpuPercent >= this.threshold * 100;
    const exceededMem = pct.memoryPercent != null && pct.memoryPercent >= this.threshold * 100;

    let exceedsThreshold = false;
    let exceededMetric: ResourceConsumptionAssessment['exceededMetric'] = null;
    if (exceededCpu && exceededMem) {
      exceedsThreshold = true;
      exceededMetric = 'both';
    } else if (exceededCpu) {
      exceedsThreshold = true;
      exceededMetric = 'cpu';
    } else if (exceededMem) {
      exceedsThreshold = true;
      exceededMetric = 'memory';
    }

    const parts: string[] = [];
    if (pct.cpuPercent != null) {
      parts.push(`CPU ${pct.cpuUsed.toLocaleString()} / ${pct.cpuLimit.toLocaleString()} (${pct.cpuPercent.toFixed(1)}%)`);
    }
    if (pct.memoryPercent != null) {
      parts.push(`RAM ${pct.memoryUsed.toLocaleString()} / ${pct.memoryLimit.toLocaleString()} bytes (${pct.memoryPercent.toFixed(1)}%)`);
    }
    const baseMsg = parts.length > 0 ? `Resource usage: ${parts.join('; ')}` : 'No resource consumption metrics found in diagnostic events';
    const message = exceedsThreshold
      ? `${baseMsg} — exceeds threshold of ${(this.threshold * 100).toFixed(0)}%`
      : baseMsg;

    const assessment: ResourceConsumptionAssessment = {
      hasData,
      cpuPercent: pct.cpuPercent,
      memoryPercent: pct.memoryPercent,
      cpuUsed: pct.cpuUsed,
      cpuLimit: pct.cpuLimit,
      memoryUsed: pct.memoryUsed,
      memoryLimit: pct.memoryLimit,
      threshold: this.threshold,
      exceedsThreshold,
      exceededMetric,
      message,
    };

    if (exceedsThreshold) {
      log.warn({ ...assessment }, 'Soroban resource consumption exceeds warning threshold');
    } else if (hasData) {
      log.debug({ ...assessment }, 'Soroban resource consumption within limits');
    }

    return assessment;
  }
}

export const resourceConsumptionSentinel = new ResourceConsumptionSentinel();
