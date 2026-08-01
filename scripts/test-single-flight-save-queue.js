// Phase 2A / A2 — unit test of the exact single-flight queueing pattern used
// by saveCurrentUpload() in dashboard/index.html:
//   saveQueue = saveQueue.then(run, run); return saveQueue;
// dashboard/index.html is a browser script (relies on window/fetch/DOM
// globals) and isn't imported directly here; this test replicates the
// queueing primitive in isolation to prove the pattern itself guarantees
// FIFO, non-overlapping execution regardless of how many times it's called
// within the same synchronous tick — which is exactly the property the
// account-persistence race depended on NOT holding. Full behavioral
// verification of the actual save path lives in
// scripts/test-save-upload-persistence.js (server side) and the controlled
// QA validation procedure against a live upload (client + server together).
//
// Usage: node scripts/test-single-flight-save-queue.js

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function makeQueue(){
  let saveQueue = Promise.resolve();
  return function enqueue(run){
    saveQueue = saveQueue.then(run, run);
    return saveQueue;
  };
}

// 1. Three calls fired in the same synchronous tick must execute strictly
// one at a time, in call order, never overlapping.
{
  const enqueue = makeQueue();
  const events = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  function work(label, delayMs){
    return async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      events.push(`start:${label}`);
      await new Promise(r => setTimeout(r, delayMs));
      events.push(`end:${label}`);
      inFlight -= 1;
    };
  }
  // Deliberately fire the SLOWEST work item first, to prove a fast later
  // call still waits its turn rather than finishing first.
  const p1 = enqueue(work('A', 30));
  const p2 = enqueue(work('B', 5));
  const p3 = enqueue(work('C', 5));
  await Promise.all([p1, p2, p3]);
  assert(maxConcurrent === 1, `no two queued saves ever run concurrently (observed max concurrent = ${maxConcurrent})`);
  assert(events.join(',') === 'start:A,end:A,start:B,end:B,start:C,end:C', `three saves queued in the same tick execute strictly in call order regardless of individual duration (got: ${events.join(',')})`);
}

// 2. A failure in one queued save must not break the chain for the next one
// (mirrors performSaveCurrentUpload()'s own try/catch, but proves the queue
// itself is resilient even if a caller's work function throws uncaught).
{
  const enqueue = makeQueue();
  const events = [];
  const p1 = enqueue(async () => { events.push('A'); throw new Error('simulated save failure'); });
  const p2 = enqueue(async () => { events.push('B'); return 'ok'; });
  await Promise.allSettled([p1, p2]);
  assert(events.join(',') === 'A,B', 'a queued save that throws does not prevent the next queued save from running');
}

// 3. Interleaved bursts: calls made AFTER earlier ones have already started
// (but not finished) still queue correctly rather than racing ahead.
{
  const enqueue = makeQueue();
  const events = [];
  function work(label, delayMs){
    return async () => { events.push(`start:${label}`); await new Promise(r => setTimeout(r, delayMs)); events.push(`end:${label}`); };
  }
  const p1 = enqueue(work('A', 20));
  await new Promise(r => setTimeout(r, 5)); // A is now in flight but not done
  const p2 = enqueue(work('B', 1));         // queued while A is still running
  await Promise.all([p1, p2]);
  assert(events.join(',') === 'start:A,end:A,start:B,end:B', `a save queued while an earlier one is still in flight still waits for it to finish first (got: ${events.join(',')})`);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
