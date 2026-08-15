// Phase 1 monitoring-architecture foundation: the first, deliberately
// narrow slice of api/research-batch.js's core pipeline pulled into a
// shared, request/response-free module so a future background Queue
// worker can reuse it in-process -- no HTTP self-call into
// /api/research-batch, no nested-timeout stacking on top of that
// endpoint's own ~58s platform ceiling.
//
// SCOPE OF THIS EXTRACTION, AND WHY IT IS NARROW:
//
// api/research-batch.js's handler() was read in full while planning this
// work. The "discovery -> prompt construction -> OpenAI synthesis" front
// half is genuinely separable: discoverCandidatesForAccounts(),
// accountPromptContext(), pairedPurchases(), and callOpenAIJson() are
// already standalone functions with no request/response coupling at all
// -- they are now exported directly from api/research-batch.js (see that
// file) so a future worker can import them without an HTTP hop. Moving
// them into a second file would only relocate text, not reduce risk or
// change behavior, and this module intentionally does not re-export them
// from here to avoid a circular import between the two files (research-
// batch.js needs runBudgetedSynthesis from THIS module; this module has
// no need to import anything back from research-batch.js).
//
// The one piece that genuinely needed to change, not just move, is the
// budget-gated synthesis call: runBudgetedSynthesis() below is the exact
// same deadline-check-then-call decision that was previously inline in
// api/research-batch.js's handler() (reading REQUEST_DEADLINE_MS /
// MIN_USEFUL_OPENAI_MS / OPENAI_CALL_MAX_MS as hardcoded module
// constants), now with budget as an explicit parameter. The interactive
// handler passes those exact same constants explicitly, so its own
// behavior is provably unchanged (see scripts/test-research-pipeline-
// extraction.js); a future worker can pass its own, independently larger
// budget instead.
//
// WHAT IS DELIBERATELY NOT EXTRACTED YET, AND WHY: the remaining tail --
// parsing the model's raw response, per-signal account-name resolution,
// makeSignal()/normalizeOpportunity()/validateOpportunity()/
// verifyCandidateCompanyGrounding(), and resolveOpportunityEvents() --
// is roughly 600 further lines, tightly interleaved with mode-specific
// branches (prospect-intelligence's fallback-signal generation,
// warm-account/mixed-mode quality gating, identity-bootstrap diagnostics)
// and extensive diagnostic logging. It has real test coverage for specific
// behavioral properties (scripts/test-research-batch-zero-candidate-
// policy.js, scripts/test-research-batch-weekly-monitoring-auth.js) but
// no full end-to-end characterization/snapshot coverage of its output for
// realistic multi-signal input. Moving ~600 lines of that density in one
// pass, without characterization tests locking down today's exact output
// first, is a real regression risk this phase's "existing interactive
// research behavior must remain functionally unchanged" requirement does
// not accept casually. Recommendation (see the Phase 1 report): extract
// that tail as its own dedicated follow-up, adding characterization tests
// against realistic fixture input BEFORE moving anything, verified
// incrementally against the full suite rather than as one bundled cut.
// A future single-account worker still needs that tail, so it is not
// avoidable work -- only deliberately sequenced into a safer later step.
export async function runBudgetedSynthesis({
  prompt,
  apiKey,
  model,
  startedAt,
  requestDeadlineMs,
  minUsefulOpenAiMs,
  openAiCallMaxMs,
  callOpenAIJson
}) {
  const remainingMs = requestDeadlineMs - (Date.now() - startedAt);
  if (remainingMs < minUsefulOpenAiMs) {
    throw new Error(`Research incomplete: only ${Math.max(0, Math.round(remainingMs))}ms of budget remained before signal synthesis -- not enough to run reliably. Please try again.`);
  }
  return callOpenAIJson({ apiKey, model, prompt, timeoutMs: Math.min(remainingMs, openAiCallMaxMs) });
}
