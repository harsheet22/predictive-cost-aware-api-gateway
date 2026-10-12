'use strict';
const express = require('express');
module.exports = function externalRouter(sessions) {
  const router=express.Router();
  const wrap=fn => (req,res) => Promise.resolve().then(()=>fn(req,res)).catch(error=>{ if (!res.destroyed && !res.headersSent) res.status(error.status || 400).json({error:error.message}); });
  router.get('/latest', (req,res)=>res.json(sessions.status()));
  router.get('/history',(req,res)=>res.json(sessions.history()));
  router.get('/:id/report',wrap(async(req,res)=>res.json(sessions.report(req.params.id))));
  router.post('/',wrap(async(req,res)=>res.status(201).json(await sessions.create(req.body.trace,req.body.drainSec))));
  router.post('/:id/:arm/begin',wrap(async(req,res)=>res.json(await sessions.begin(req.params.id,req.params.arm))));
  router.post('/:id/:arm/execute',wrap(async(req,res)=>{ const result=await sessions.execute(req.params.id,req.params.arm,req.body); res.status(result.httpStatus).json(result.outcome); }));
  router.post('/:id/:arm/finish',wrap(async(req,res)=>res.json(await sessions.finish(req.params.id,req.params.arm,req.body))));
  return router;
};
