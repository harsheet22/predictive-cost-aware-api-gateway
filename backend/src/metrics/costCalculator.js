'use strict';

/**
 * The shared cost model.
 *
 * The SAME formula computes predicted cost and actual cost; only the input
 * milliseconds differ. This means predicted-vs-actual error comes solely from
 * the cost predictor, which keeps the report's analysis clean.
 *
 * Modelled on serverless billing so every term is explainable:
 *   cost = compute + memory + invocation + egress
 */
const config = require('../config');

function roundUsd(value) {
  // Keep enough precision that micro-costs do not collapse to 0.
  return Number(value.toFixed(9));
}

/**
 * @param {object} input
 * @param {number} input.ms           billable execution time in milliseconds
 * @param {number} [input.payloadSize] payload bytes (for egress)
 * @param {number} [input.memoryMB]    memory allocation override
 * @param {number} [input.vcpuCount]   vCPU count override
 * @returns {number} estimated cost in USD
 */
function estimateCloudCost({ ms, payloadSize = 0, memoryMB, vcpuCount }) {
  const c = config.costModel;
  const billedMs = Math.max(c.minBilledMs, ms || 0);
  const seconds = billedMs / 1000;

  const vcpu = vcpuCount == null ? c.vcpuCount : vcpuCount;
  const memMB = memoryMB == null ? c.memoryMB : memoryMB;

  const computeCost = seconds * vcpu * c.pricePerVcpuSec;
  const memoryCost = seconds * (memMB / 1024) * c.pricePerGbSec;
  const invocationCost = c.pricePerInvocation;
  const egressCost = (Math.max(0, payloadSize) / 1e9) * c.pricePerGbEgress;

  return roundUsd(computeCost + memoryCost + invocationCost + egressCost);
}

/** Cost per successful request, guarded against divide-by-zero. */
function costPerSuccess(totalCostUsd, successCount) {
  if (!successCount) return 0;
  return roundUsd(totalCostUsd / successCount);
}

module.exports = { estimateCloudCost, costPerSuccess, roundUsd };
