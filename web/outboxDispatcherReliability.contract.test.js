import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("outbox worker imports side-effect-free dispatch service", () => {
  const worker = read("web/Jobs/Workers/outboxDispatcherWorker.js");
  const service = read("web/services/outboxDispatchService.js");

  assert.match(worker, /services\/outboxDispatchService\.js/);
  assert.doesNotMatch(worker, /workers\/outboxDispatcherWorker\.js/);
  assert.doesNotMatch(service, /new Worker/);
  assert.doesNotMatch(service, /from "bullmq"/);
});

test("outbox dispatch returns capacity and backlog telemetry", () => {
  const service = read("web/services/outboxDispatchService.js");

  assert.match(service, /db\.outboxEvent\.count/);
  assert.match(service, /dispatched,/);
  assert.match(service, /failed,/);
  assert.match(service, /remaining,/);
  assert.match(service, /batchLimitReached:/);
});

test("outbox worker has correlated logs and lifecycle controls", () => {
  const worker = read("web/Jobs/Workers/outboxDispatcherWorker.js");

  assert.match(worker, /jobId: job\?\.id/);
  assert.match(worker, /shop,/);
  assert.match(worker, /attemptsMade: job\?\.attemptsMade/);
  assert.match(worker, /lockDuration:/);
  assert.match(worker, /stalledInterval:/);
  assert.match(worker, /\.on\("completed"/);
  assert.match(worker, /\.on\("failed"/);
  assert.match(worker, /\.on\("stalled"/);
  assert.match(worker, /SIGTERM/);
});

test("outbox repeat registration relies on BullMQ repeat deduplication", () => {
  const worker = read("web/Jobs/Workers/outboxDispatcherWorker.js");

  assert.doesNotMatch(worker, /acquireRedisLock/);
  assert.doesNotMatch(worker, /LEADER_LOCK_TTL_MS/);
  assert.match(worker, /return enqueueOutboxDispatcherSchedulerTick/);
});
