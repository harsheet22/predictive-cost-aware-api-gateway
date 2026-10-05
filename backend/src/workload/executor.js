'use strict';

/**
 * The executor runs a request and MEASURES its true cost.
 *
 * Both gateways call exactly this. The optional `precision` overrides are what
 * make DOWNGRADE possible: the predictive gateway may run a request at reduced
 * precision (less CPU, shorter I/O) when the full variant is too expensive.
 */
const config = require('../config');
const jobs = require('./jobs');
const { estimateCloudCost } = require('../metrics/costCalculator');

function hrtimeMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * @param {object} request
 * @param {object} [overrides]
 * @param {number} [overrides.cpuFactor] multiply CPU work (e.g. 0.25)
 * @param {number} [overrides.ioFactor]  multiply I/O wait
 * @param {string} [overrides.precision] 'full' | 'reduced'
 * @returns {Promise<object>} measured execution record
 */
async function execute(request, overrides = {}) {
  const precision = overrides.precision
    || (request.precision === 'reduced' ? 'reduced' : 'full');
  const cpuFactor = overrides.cpuFactor == null ? 1 : overrides.cpuFactor;
  const ioFactor = overrides.ioFactor == null ? 1 : overrides.ioFactor;

  const iterations = Math.max(
    config.executor.minHashIterations,
    Math.round(jobs.iterationsFor(request) * cpuFactor),
  );
  const ioMs = jobs.ioMsFor(request) * ioFactor;

  const seed = `item:${request.parameters && request.parameters.itemId != null
    ? request.parameters.itemId
    : request.requestId}`;

  const wallStart = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();

  await jobs.burnCpu(iterations, seed);
  await jobs.wait(ioMs);

  const cpuUsage = process.cpuUsage(cpuStart);
  const cpuMs = (cpuUsage.user + cpuUsage.system) / 1000;
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

  const actualCloudCostUsd = estimateCloudCost({
    ms: wallMs, // bill wall time, which includes the simulated I/O wait
    payloadSize: request.payloadSize,
  });

  return {
    ok: true,
    precision,
    iterations,
    ioMs: Number(ioMs.toFixed(2)),
    cpuMs: Number(cpuMs.toFixed(3)),
    wallMs: Number(wallMs.toFixed(3)),
    actualCloudCostUsd,
    output: {
      itemId: request.parameters ? request.parameters.itemId : null,
      checksum: null,
    },
  };
}

module.exports = { execute };
