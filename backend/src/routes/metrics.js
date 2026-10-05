'use strict';

const express = require('express');

/**
 * GET /api/metrics/live  -> snapshots for every registered gateway
 * POST /api/metrics/reset -> zero all counters
 */
module.exports = function metricsRouter({ gateways }) {
  const router = express.Router();

  router.get('/live', (req, res) => {
    const payload = {};
    for (const [name, gateway] of Object.entries(gateways)) {
      payload[name] = {
        ...gateway.metrics.snapshot(),
        limiter: gateway.stats ? gateway.stats() : undefined,
      };
    }
    res.json({ gateways: payload, ts: new Date().toISOString() });
  });

  router.post('/reset', (req, res) => {
    for (const gateway of Object.values(gateways)) gateway.metrics.reset();
    res.json({ ok: true });
  });

  return router;
};
