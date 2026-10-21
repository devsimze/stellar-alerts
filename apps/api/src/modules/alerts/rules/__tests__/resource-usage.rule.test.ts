import { describe, it, expect } from 'vitest';

import {
  ResourceUsageRuleEvaluator,
  resourceUsageRuleEvaluator,
  type AlertRuleLike,
} from '../resource-usage.rule';

const rule = (overrides: Partial<AlertRuleLike> = {}): AlertRuleLike => ({
  id: 'rule-1',
  userId: 'user-1',
  walletId: 'wallet-1',
  name: 'CPU guard',
  isActive: true,
  conditions: { resourceUsage: { threshold: 0.85 } },
  ...overrides,
});

describe('ResourceUsageRuleEvaluator — Soroban resource warnings (#720)', () => {
  it('does not match when usage stays below the threshold', () => {
    const result = resourceUsageRuleEvaluator.evaluate(
      {
        diagnosticEvents: [{ cpuInsns: 1_000_000, memBytes: 1_000_000 }],
        resources: { instructions: 10_000_000 },
        txMemoryLimit: 10_000_000,
      },
      rule(),
    );

    expect(result.matched).toBe(false);
    expect(result.deliveryPayload).toBeUndefined();
  });

  it('matches and produces a notification payload when CPU usage exceeds the threshold', () => {
    const result = resourceUsageRuleEvaluator.evaluate(
      {
        diagnosticEvents: [{ cpuInsns: 9_000_000 }],
        resources: { instructions: 10_000_000 },
      },
      rule(),
      { txHash: 'abc123', contractId: 'contract-1' },
    );

    expect(result.matched).toBe(true);
    expect(result.ruleId).toBe('rule-1');
    expect(result.deliveryPayload).toMatchObject({
      event: 'soroban.resource_usage_alert',
      ruleId: 'rule-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      contractId: 'contract-1',
      txHash: 'abc123',
    });
    expect(result.deliveryPayload?.metadata.cpuPercent).toBeCloseTo(90);
    expect(result.deliveryPayload?.metadata.exceededMetric).toBe('cpu');
    expect(result.deliveryPayload?.metadata.severity).toBe('warning');
  });

  it('honours the per-rule threshold from conditions', () => {
    const source = {
      diagnosticEvents: [{ cpuInsns: 6_000_000 }],
      resources: { instructions: 10_000_000 },
    };

    const strict = resourceUsageRuleEvaluator.evaluate(
      source,
      rule({ conditions: { resourceUsage: { threshold: 0.9 } } }),
    );
    expect(strict.matched).toBe(false);

    const lenient = resourceUsageRuleEvaluator.evaluate(
      source,
      rule({ conditions: { resourceUsage: { threshold: 0.5 } } }),
    );
    expect(lenient.matched).toBe(true);
  });

  it('skips inactive rules', () => {
    const result = resourceUsageRuleEvaluator.evaluate(
      {
        diagnosticEvents: [{ cpuInsns: 9_500_000 }],
        resources: { instructions: 10_000_000 },
      },
      rule({ isActive: false }),
    );

    expect(result.matched).toBe(false);
  });

  it('filters by monitored contract ids', () => {
    const source = {
      contractId: 'contract-other',
      diagnosticEvents: [{ cpuInsns: 9_500_000 }],
      resources: { instructions: 10_000_000 },
    };

    const filtered = resourceUsageRuleEvaluator.evaluate(
      source,
      rule({ conditions: { resourceUsage: { threshold: 0.85, contractIds: ['contract-1'] } } }),
    );
    expect(filtered.matched).toBe(false);

    const allowed = resourceUsageRuleEvaluator.evaluate(
      source,
      rule({ conditions: { resourceUsage: { threshold: 0.85, contractIds: ['contract-other'] } } }),
    );
    expect(allowed.matched).toBe(true);
  });

  it('evaluates a bare diagnostic-event source without a persisted rule', () => {
    const evaluator = new ResourceUsageRuleEvaluator();
    const result = evaluator.evaluateSource({
      source: {
        diagnosticEvents: [{ memBytes: 8_000_000 }],
        txMemoryLimit: 8_388_608,
      },
      txHash: 'tx-1',
    });

    expect(result.fired).toBe(true);
    expect(result.shouldAlert).toBe(true);
    expect(result.assessment.exceededMetric).toBe('memory');
  });
});
