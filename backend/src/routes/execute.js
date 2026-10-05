'use strict';

const express = require('express');
const config = require('../config');
const { generateRequests } = require('../simulator/simulator');

/**
 * POST /api/execute
 *
 * Body may be:
 *   { "gateway": "baseline", "request": { ...GatewayRequest } }   -> run that request
 *   { "gateway": "baseline", "type": "hash_compute" }             -> synthesize + run
 *
 * Useful for exercising the pipeline one request at a time.
 */
module.exports = function executeRouter({ gateways }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const body = req.body || {};
    const gatewayName = body.gateway || 'baseline';
    const gateway = gateways[gatewayName];
    if (!gateway) {
      return res.status(404).json({ error: `unknown gateway '${gatewayName}'` });
    }

    let request = body.request;
    if (!request) {
      const type = body.type && config.requestTypes[body.type] ? body.type : 'hash_compute';
      const stream = generateRequests({
        profile: 'light',
        count: 1,
        seed: Date.now() % 100000,
        typeWeights: { [type]: 1 },
      });
      request = stream[0];
    }

    if (!request || !request.requestId || !request.type) {
      return res.status(400).json({ error: 'a valid GatewayRequest is required' });
    }

    const result = await gateway.handle(request);
    res.json(result);
  });

  return router;
};
