'use strict';
const PredictionQueue = require('../src/ml/predictionQueue');

test('prediction tasks start FIFO, with bounded concurrency; rejection releases a slot', async () => {
  const queue = new PredictionQueue(2, { normalWaitMs: 10000, highWaitMs: 10000 });
  const starts = [];
  const controls = [];
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 5 }, (_, index) => queue.run(() => {
    starts.push(index);
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve, reject) => {
      controls[index] = {
        resolve: () => { active--; resolve(index); },
        reject: () => { active--; reject(new Error('failed')); },
      };
    });
  }));
  // Attach the error handler before deliberately rejecting.
  const failed = expect(tasks[0]).rejects.toThrow('failed');
  await Promise.resolve();
  expect(starts).toEqual([0, 1]);
  expect(queue.stats().queued).toBe(3);
  controls[0].reject();
  await failed;
  expect(starts).toEqual([0, 1, 2]);
  controls[1].resolve();
  await tasks[1];
  controls[2].resolve();
  await tasks[2];
  controls[3].resolve();
  await tasks[3];
  controls[4].resolve();
  await tasks[4];
  expect(starts).toEqual([0, 1, 2, 3, 4]);
  expect(peak).toBe(2);
  expect(queue.stats()).toMatchObject({ running: 0, queued: 0, peakQueued: 3 });
});

test('synchronous task errors do not strand following predictions', async () => {
  const queue = new PredictionQueue(1, { normalWaitMs: 10000, highWaitMs: 10000 });
  const failed = queue.run(() => { throw new Error('sync'); });
  const next = queue.run(() => 42);
  await expect(failed).rejects.toThrow('sync');
  await expect(next).resolves.toBe(42);
  expect(queue.stats().running).toBe(0);
});

test.each([0, -1, 1.5, NaN])('rejects invalid concurrency %s', value => {
  expect(() => new PredictionQueue(value)).toThrow(RangeError);
});
