import {
  ResourceConsumptionSentinel,
  type ResourceConsumptionAssessment,
} from '../../../workers/watcher/resource-sentinel';
import { createLogger } from '../../../lib/logger';

const log = createLogger({ module: 'ResourceUsageRule' });

/** Minimal shape of an AlertRule row, as stored by the alerts module. */
export interface AlertRuleLike {
  id: string;
  userId: string;
  walletId?: string | null;
  name?: string | null;
  isActive: boolean;
  conditions?: unknown;
}

/** Rule configuration carried on `AlertRule.conditions.resourceUsage`. */
export interface ResourceUsageRuleConfig {
  /** Fraction of the limit (0–1) that triggers the warning. Defaults to 0.85. */
  threshold?: number;
  /** Only evaluate invocations of these contract IDs. */
  contractIds?: string[];
}

export interface ResourceUsageRuleInput {
  /** Diagnostic event data or full transaction/result object to analyze. */
  source: unknown;
  threshold?: number;
  /** Optional transaction identifier for alert context. */
  txHash?: string;
  contractId?: string;
}

export interface ResourceUsageRuleResult {
  fired: boolean;
  assessment: ResourceConsumptionAssessment;
  shouldAlert: boolean;
}

export interface ResourceUsageRuleMatchResult {
  matched: boolean;
  ruleId?: string;
  deliveryPayload?: {
    event: 'soroban.resource_usage_alert';
    ruleId: string;
    userId: string;
    walletId?: string | null;
    contractId?: string;
    txHash?: string;
    assessment: ResourceConsumptionAssessment;
    metadata: Record<string, unknown>;
  };
}

/**
 * Alert rule that fires when a Soroban contract invocation approaches the
 * ledger resource limits (#720).
 *
 * `ResourceConsumptionSentinel` turns the CPU/memory meters reported by
 * Soroban diagnostic events into percentages against the declared limits; this
 * rule turns those percentages into a notification payload when usage crosses
 * the configured threshold (default 85%).
 */
export class ResourceUsageRuleEvaluator {
  private readonly sentinel: ResourceConsumptionSentinel;

  constructor(sentinel: ResourceConsumptionSentinel = new ResourceConsumptionSentinel()) {
    this.sentinel = sentinel;
  }

  /**
   * Evaluates diagnostic events against an AlertRule configured for resource
   * usage warnings.
   */
  public evaluate(
    source: unknown,
    rule: AlertRuleLike,
    context: { txHash?: string; contractId?: string } = {},
  ): ResourceUsageRuleMatchResult {
    if (!rule.isActive) {
      return { matched: false };
    }

    const config = this.extractRuleConfig(rule);
    const contractId = context.contractId ?? this.extractContractId(source);

    if (config?.contractIds && config.contractIds.length > 0) {
      if (!contractId || !config.contractIds.some((c) => c.toLowerCase() === contractId.toLowerCase())) {
        return { matched: false };
      }
    }

    const threshold = config?.threshold;
    const assessment =
      threshold === undefined
        ? this.sentinel.assess(source)
        : new ResourceConsumptionSentinel({ threshold }).assess(source);
    if (!assessment.exceedsThreshold) {
      return { matched: false };
    }

    log.warn(
      {
        ruleId: rule.id,
        txHash: context.txHash,
        contractId,
        cpuPercent: assessment.cpuPercent,
        memoryPercent: assessment.memoryPercent,
        exceededMetric: assessment.exceededMetric,
        cpuUsed: assessment.cpuUsed,
        cpuLimit: assessment.cpuLimit,
        memoryUsed: assessment.memoryUsed,
        memoryLimit: assessment.memoryLimit,
      },
      'Resource usage alert rule fired',
    );

    return {
      matched: true,
      ruleId: rule.id,
      deliveryPayload: {
        event: 'soroban.resource_usage_alert',
        ruleId: rule.id,
        userId: rule.userId,
        walletId: rule.walletId ?? null,
        contractId,
        txHash: context.txHash,
        assessment,
        metadata: {
          exceededMetric: assessment.exceededMetric,
          cpuPercent: assessment.cpuPercent,
          memoryPercent: assessment.memoryPercent,
          cpuUsed: assessment.cpuUsed,
          cpuLimit: assessment.cpuLimit,
          memoryUsed: assessment.memoryUsed,
          memoryLimit: assessment.memoryLimit,
          threshold: assessment.threshold,
          severity: 'warning',
          message: assessment.message,
        },
      },
    };
  }

  /**
   * Evaluates a diagnostic-event source without a persisted AlertRule. Used by
   * watchers that only need the assessment (and its alert decision).
   */
  public evaluateSource(input: ResourceUsageRuleInput): ResourceUsageRuleResult {
    const threshold = input.threshold ?? this.sentinel.getThreshold();
    const assessment = new ResourceConsumptionSentinel({ threshold }).assess(input.source);
    const fired = assessment.exceedsThreshold;

    if (fired) {
      log.warn(
        {
          txHash: input.txHash,
          contractId: input.contractId,
          cpuPercent: assessment.cpuPercent,
          memoryPercent: assessment.memoryPercent,
          exceededMetric: assessment.exceededMetric,
          cpuUsed: assessment.cpuUsed,
          cpuLimit: assessment.cpuLimit,
        },
        'Resource usage alert rule fired',
      );
    }

    return { fired, assessment, shouldAlert: fired };
  }

  private extractRuleConfig(rule: AlertRuleLike): ResourceUsageRuleConfig | null {
    if (!rule.conditions || typeof rule.conditions !== 'object') return null;

    const conditions = rule.conditions as Record<string, unknown>;
    const candidate = conditions.resourceUsage;

    if (candidate && typeof candidate === 'object') {
      return candidate as ResourceUsageRuleConfig;
    }

    if ('threshold' in conditions || 'contractIds' in conditions) {
      return conditions as ResourceUsageRuleConfig;
    }

    return null;
  }

  private extractContractId(source: unknown): string | undefined {
    if (!source || typeof source !== 'object') return undefined;
    const obj = source as Record<string, unknown>;
    const candidates = [obj.contractId, obj.contract_id, obj.contract];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return undefined;
  }
}

export const resourceUsageRuleEvaluator = new ResourceUsageRuleEvaluator();
