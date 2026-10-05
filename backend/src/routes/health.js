'use strict';

const express = require('express');
const config = require('../config');

const startedAt = Date.now();

module.exports = function healthRouter() {
  const router = express.Router();
  router.get('/', (req, res) => {
    res.json({
      status: 'ok',
      service: 'predictive-gateway-backend',
      uptimeMs: Date.now() - startedAt,
      ports: config.ports,
      slaTargetMs: config.sla.targetLatencyMs,
    });
  });
  return router;
};
