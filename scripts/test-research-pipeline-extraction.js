// Phase 1 monitoring-architecture foundation -- proves the
// runBudgetedSynthesis() extraction (api/lib/research-pipeline.js) is
// behaviorally identical to the inline deadline-check-then-call logic it
// replaced in api/research-batch.js's handler(), AND that a caller can
// supply an independent, larger budget (the future background worker's
// need) without touching the interactive endpoint's own constants.
//
// Usage: node scripts/test-research-pipeline-extraction.js
import { runBudgetedSynthesis } from '../api/lib/research-pipeline.js';
import { REQUEST_DEADLINE_MS, MIN_USEFUL_OPENAI_MS, OPENAI_CALL_MAX_MS } from '../api/research-batch.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

async function assertRejects(promise, matcher, message) {
  try {
    await promise;
    failures += 1;
    console.error(`FAIL: ${message} (did not reject)`);
  } catch (err) {
    if (matcher(err)) console.log(`PASS: ${message}`);
    else { failures += 1; console.error(`FAIL: ${message} (rejected with unexpected error: ${err.message})`); }
  }
}

// --- the interactive endpoint's own constants are unchanged by the extraction ---
assert(REQUEST_DEADLINE_MS === 50000, `REQUIRED: REQUEST_DEADLINE_MS is unchanged at 50000 after extraction (got ${REQUEST_DEADLINE_MS})`);
assert(MIN_USEFUL_OPENAI_MS === 15000, `REQUIRED: MIN_USEFUL_OPENAI_MS is unchanged at 15000 after extraction (got ${MIN_USEFUL_OPENAI_MS})`);
assert(OPENAI_CALL_MAX_MS === 45000, `REQUIRED: OPENAI_CALL_MAX_MS is unchanged at 45000 after extraction (got ${OPENAI_CALL_MAX_MS})`);

// --- insufficient-budget fail-fast, same message shape as the original inline throw ---
await assertRejects(
  runBudgetedSynthesis({
    prompt: 'irrelevant',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    startedAt: Date.now() - 40000, // 40s already elapsed of a 50s budget -> 10s remaining, below the 15s floor
    requestDeadlineMs: REQUEST_DEADLINE_MS,
    minUsefulOpenAiMs: MIN_USEFUL_OPENAI_MS,
    openAiCallMaxMs: OPENAI_CALL_MAX_MS,
    callOpenAIJson: async () => { throw new Error('should never be called -- budget check must fail first'); }
  }),
  err => /Research incomplete: only \d+ms of budget remained before signal synthesis/.test(err.message),
  'REQUIRED: insufficient remaining budget fails fast with the same message shape as the original inline check, before the OpenAI call is ever attempted'
);

// --- sufficient budget: calls through with timeoutMs = min(remaining, openAiCallMaxMs) ---
{
  let capturedTimeoutMs = null;
  const startedAt = Date.now() - 5000; // 5s elapsed of a 50s budget -> 45s remaining, capped by openAiCallMaxMs (45s)
  const result = await runBudgetedSynthesis({
    prompt: 'irrelevant',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    startedAt,
    requestDeadlineMs: REQUEST_DEADLINE_MS,
    minUsefulOpenAiMs: MIN_USEFUL_OPENAI_MS,
    openAiCallMaxMs: OPENAI_CALL_MAX_MS,
    callOpenAIJson: async ({ timeoutMs }) => { capturedTimeoutMs = timeoutMs; return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; }
  });
  assert(result.text === 'ok', 'a sufficient-budget call returns whatever the injected callOpenAIJson resolves with, unchanged');
  assert(capturedTimeoutMs !== null && capturedTimeoutMs <= OPENAI_CALL_MAX_MS, `REQUIRED: timeoutMs passed to callOpenAIJson is capped at openAiCallMaxMs (got ${capturedTimeoutMs})`);
  assert(capturedTimeoutMs > 40000 && capturedTimeoutMs <= 45000, `timeoutMs reflects remaining budget capped by the 45s ceiling, matching the original Math.min(remainingMs, OPENAI_CALL_MAX_MS) (got ${capturedTimeoutMs})`);
}

// --- REQUIRED: a caller-specific (future worker) budget works independently ---
{
  let capturedTimeoutMs = null;
  const workerRequestDeadlineMs = 150000; // a hypothetical worker budget, larger than the interactive endpoint's 50s
  const workerOpenAiCallMaxMs = 120000;
  const startedAt = Date.now() - 5000;
  await runBudgetedSynthesis({
    prompt: 'irrelevant',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    startedAt,
    requestDeadlineMs: workerRequestDeadlineMs,
    minUsefulOpenAiMs: MIN_USEFUL_OPENAI_MS,
    openAiCallMaxMs: workerOpenAiCallMaxMs,
    callOpenAIJson: async ({ timeoutMs }) => { capturedTimeoutMs = timeoutMs; return { text: 'ok', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }; }
  });
  assert(capturedTimeoutMs > OPENAI_CALL_MAX_MS, `REQUIRED: a caller-provided larger budget (simulating a future background worker) produces a timeoutMs beyond the interactive endpoint's own 45s ceiling (got ${capturedTimeoutMs}), proving budgets are independent per caller`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
