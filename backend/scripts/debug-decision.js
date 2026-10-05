const config = require('../src/config');
const { generateRequests } = require('../src/simulator/simulator');
const MetricsStore = require('../src/metrics/metricsStore');
const PredictiveGateway = require('../src/gateways/predictiveGateway');

const metrics = new MetricsStore('test');
const gateway = new PredictiveGateway(metrics);

const requests = generateRequests({ profile: 'normal', durationSec: 1, seed: 42 });
console.log('Generated:', requests.length);

async function test() {
  for (let i = 0; i < Math.min(5, requests.length); i++) {
    const req = requests[i];
    const decision = gateway.engine.decide(req, {
      cpuPct: 0,
      queueDepth: gateway.rate.queue.length,
      concurrent: gateway.rate.active,
    });
    console.log('Req ' + i + ': ' + req.type + ' -> ' + decision.decision + ' (' + decision.reason + '), predUsd=' + decision.predictedCloudCostUsd + ', budgetRem=' + decision.budgetRemainingUsd);
  }
}
test().then(() => process.exit(0));