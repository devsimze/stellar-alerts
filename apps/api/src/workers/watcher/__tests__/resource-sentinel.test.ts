import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  ResourceConsumptionSentinel,
  computeResourcePercentages,
  extractResourceMetricsFromDiagnosticEvents,
  DEFAULT_RESOURCE_USAGE_THRESHOLD,
} from '../resource-sentinel';

describe('ResourceConsumptionSentinel — extraction from diagnostic events (#720)', () => {
  it('extracts CPU and memory from core_metrics on diagnostic events', () => {
    const source = {
      diagnosticEvents: [
        {
          coreMetrics: {
            cpuInstructions: 850000,
            memoryBytes: 4194304, // 4MB
          },
        },
      ],
      resources: {
        instructions: 10_000_000,
        readBytes: 65536,
      },
      txMemoryLimit: 8_388_608, // 8MB
    };

    const metrics = extractResourceMetricsFromDiagnosticEvents(source);
    expect(metrics.cpuInstructions).toBe(850000);
    expect(metrics.memoryBytes).toBe(4194304);
  });

  it('sums CPU/memory across multiple diagnostic events', () => {
    const source = {
      diagnosticEvents: [
        { cpuInsns: 400000, memBytes: 1_000_000 },
        { cpuInstructions: 500000, memoryBytes: 2_000_000 },
      ],
      transactionData: {
        resources: { instructions: 10_000_000, readBytes: 0, writeBytes: 5_000_000 },
      },
    };

    const metrics = extractResourceMetricsFromDiagnosticEvents(source);
    const pct = computeResourcePercentages(metrics);
    expect(pct.cpuUsed).toBe(900000);
    expect(pct.memoryUsed).toBe(3_000_000);
    expect(pct.cpuLimit).toBe(10_000_000);
    expect(pct.memoryLimit).toBe(5_000_000);
  });

  it('computes percentages against ledger/tx limits', () => {
    const pct = computeResourcePercentages({
      cpuInstructions: 8_500_000,
      memoryBytes: 7_077_888, // ~6.75MB
      cpuLimit: 10_000_000,
      memoryLimit: 8_388_608, // 8MB
    });
    expect(pct.cpuPercent).toBeCloseTo(85.0, 1);
    expect(pct.memoryPercent).toBeCloseTo(84.4, 1);
  });
});

describe('ResourceConsumptionSentinel — alerts when exceeding 85% (#720)', () => {
  it('triggers warning notification when CPU exceeds threshold', () => {
    const sentinel = new ResourceConsumptionSentinel({ threshold: 0.85 });
    const assessment = sentinel.assess({
      diagnosticEvents: [{ cpuInsns: 9_000_000, memBytes: 1_000_000 }],
      resources: { instructions: 10_000_000, readBytes: 10_000, writeBytes: 1_000_000 },
    });
    expect(assessment.exceedsThreshold).toBe(true);
    expect(assessment.exceededMetric).toBe('cpu');
    expect(assessment.cpuPercent).toBeCloseTo(90.0);
    expect(assessment.message).toMatch(/exceeds threshold/i);
  });

  it('triggers warning when memory exceeds threshold', () => {
    const sentinel = new ResourceConsumptionSentinel();
    const assessment = sentinel.assess({
      diagnosticEvents: [{ memoryBytes: 8_000_000 }],
      txMemoryLimit: 8_388_608, // 8MB limit; 8M/8.38M ~95.4%
    });
    expect(assessment.memoryPercent).toBeGreaterThan(DEFAULT_RESOURCE_USAGE_THRESHOLD * 100);
    expect(assessment.exceedsThreshold).toBe(true);
    expect(assessment.exceededMetric).toBe('memory');
  });

  it('reports both metrics when both exceed threshold', () => {
    const sentinel = new ResourceConsumptionSentinel({ threshold: 0.5 });
    const assessment = sentinel.assess({
      diagnosticEvents: [
        { cpuInsns: 6_000_000, memBytes: 6_000_000 },
      ],
      resources: { instructions: 10_000_000, readBytes: 0, writeBytes: 10_000_000 },
      txMemoryLimit: 10_000_000,
    });
    expect(assessment.exceedsThreshold).toBe(true);
    expect(assessment.exceededMetric).toBe('both');
  });

  it('does not alert when usage is below threshold', () => {
    const sentinel = new ResourceConsumptionSentinel();
    const assessment = sentinel.assess({
      diagnosticEvents: [{ cpuInsns: 5_000_000, memBytes: 2_000_000 }],
      resources: { instructions: 10_000_000, readBytes: 0, writeBytes: 8_000_000 },
    });
    expect(assessment.exceedsThreshold).toBe(false);
    expect(assessment.exceededMetric).toBeNull();
  });

  it('handles sources without metrics gracefully', () => {
    const sentinel = new ResourceConsumptionSentinel();
    const assessment = sentinel.assess({});
    expect(assessment.hasData).toBe(false);
    expect(assessment.exceedsThreshold).toBe(false);
  });
});
