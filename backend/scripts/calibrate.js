'use strict';

/**
 * Measure SHA-256 throughput on THIS machine and suggest a value for
 * config.executor.hashIterationsPerUnit so job costs are meaningful.
 *
 * Usage: node backend/scripts/calibrate.js [targetMsPerUnit]
 */
const config = require('../src/config');
const jobs = require('../src/workload/jobs');

function timeRounds(iterations, rounds = 3) {
  // warm up
  jobs.hashRounds(2000, 'warmup');
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = process.hrtime.bigint();
    jobs.hashRounds(iterations, 'cal');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

function main() {
  const probe = 20000;
  const ms = timeRounds(probe);
  const usPerRound = (ms * 1000) / probe;

  console.log('SHA-256 round throughput (this machine)');
  console.log(`  ${probe} rounds in ~${ms.toFixed(2)} ms`);
  console.log(`  ~${usPerRound.toFixed(3)} us/round`);

  console.log('\nCurrent config.executor.hashIterationsPerUnit =', config.executor.hashIterationsPerUnit);
  const avgPayload = (config.simulator.payloadBytes.min + config.simulator.payloadBytes.max) / 2;
  console.log(`\nEstimated cost per request type at avg payload ${Math.round(avgPayload)} B (CPU only, excludes I/O):`);
  for (const [type, def] of Object.entries(config.requestTypes)) {
    const payloadCpu = (avgPayload / 1000) * (def.payloadCpuFactor || 0);
    const units = def.cpuUnits + payloadCpu;
    const iterations = Math.max(
      config.executor.minHashIterations,
      Math.round(units * config.executor.hashIterationsPerUnit),
    );
    const cpuMs = (iterations * usPerRound) / 1000;
    console.log(
      `  ${type.padEnd(16)} cpuUnits=${String(def.cpuUnits).padStart(3)} ` +
      `iterations=${String(iterations).padStart(6)}  ~${cpuMs.toFixed(1)} ms CPU`,
    );
  }
  console.log('\nTip: to make a "cheap" unit ~2 ms of CPU, set hashIterationsPerUnit ~= 570.');
}

main();
