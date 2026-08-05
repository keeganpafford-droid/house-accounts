// Commercial-readiness core validation, item 1: aggregates the structured
// per-run provider-usage log lines api/research-batch.js emits (prefixed
// "[research-batch.provider-usage]") into the totals a controlled paid-beta
// cost benchmark needs. Deliberately NOT a new metering system -- it only
// reads what the handler already logs on every invocation; there is no
// database write, no new schema, and no background job.
//
// Usage:
//   node scripts/aggregate-provider-usage.js path/to/exported-logs.txt
//   vercel logs --output raw <deployment> | node scripts/aggregate-provider-usage.js
//
// Input format: any text stream containing lines with
// "[research-batch.provider-usage] { ...json... }" -- lines that don't
// match are silently skipped, so a raw, unfiltered Vercel log export can be
// piped in directly without pre-processing.
//
// IMPORTANT LIMITATION (see report item 5): OpenAI/Serper/Firecrawl calls
// are made ONCE per batch request covering every account in that request,
// not once per account -- there is no true per-account token/query
// breakdown at the provider level. "Usage per account" below is therefore
// an AVERAGE (the run's total usage divided by its accountsAttempted), not
// a measured per-account cost. This is stated plainly rather than presented
// as more precise than it is.

import { createInterface } from 'readline';
import { estimateRunCostUsd, PROVIDER_PRICING } from './provider-pricing.js';

const LOG_MARKER = '[research-batch.provider-usage]';

function extractJsonAfterMarker(line) {
  const idx = line.indexOf(LOG_MARKER);
  if (idx === -1) return null;
  const jsonStart = line.indexOf('{', idx);
  if (jsonStart === -1) return null;
  try {
    return JSON.parse(line.slice(jsonStart));
  } catch {
    return null;
  }
}

export async function readUsageRecords(input) {
  const records = [];
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const record = extractJsonAfterMarker(line);
    if (record && record.run && record.openai && record.serper && record.firecrawl) {
      records.push(record);
    }
  }
  return records;
}

export function aggregate(records, pricing = PROVIDER_PRICING) {
  const perRun = records.map(r => {
    const cost = estimateRunCostUsd(r, pricing);
    return {
      uploadId: r.run.uploadId,
      researchRunId: r.run.researchRunId,
      mode: r.run.mode,
      accountsAttempted: r.run.accountsAttempted,
      accountsWithSignals: r.run.accountsWithSignals,
      accountsWithNoSignals: r.run.accountsWithNoSignals,
      signalsProduced: r.run.signalsProduced,
      elapsedMs: r.run.elapsedMs,
      openaiCalls: r.openai.calls,
      openaiFailures: r.openai.failures,
      openaiInputTokens: r.openai.inputTokens,
      openaiOutputTokens: r.openai.outputTokens,
      serperQueries: r.serper.queries,
      serperFailedQueries: r.serper.failedQueries,
      firecrawlRequests: r.firecrawl.requests,
      firecrawlFailures: r.firecrawl.failures,
      ...cost
    };
  });

  const totals = perRun.reduce((acc, run) => {
    acc.runs += 1;
    acc.accountsAttempted += run.accountsAttempted;
    acc.accountsWithSignals += run.accountsWithSignals;
    acc.accountsWithNoSignals += run.accountsWithNoSignals;
    acc.signalsProduced += run.signalsProduced;
    acc.elapsedMs += run.elapsedMs;
    acc.openaiCalls += run.openaiCalls;
    acc.openaiFailures += run.openaiFailures;
    acc.openaiInputTokens += run.openaiInputTokens;
    acc.openaiOutputTokens += run.openaiOutputTokens;
    acc.serperQueries += run.serperQueries;
    acc.serperFailedQueries += run.serperFailedQueries;
    acc.firecrawlRequests += run.firecrawlRequests;
    acc.firecrawlFailures += run.firecrawlFailures;
    acc.openaiCostUsd += run.openaiCostUsd;
    acc.serperCostUsd += run.serperCostUsd;
    acc.firecrawlCostUsd += run.firecrawlCostUsd;
    acc.totalCostUsd += run.totalCostUsd;
    return acc;
  }, {
    runs: 0, accountsAttempted: 0, accountsWithSignals: 0, accountsWithNoSignals: 0,
    signalsProduced: 0, elapsedMs: 0, openaiCalls: 0, openaiFailures: 0,
    openaiInputTokens: 0, openaiOutputTokens: 0, serperQueries: 0, serperFailedQueries: 0,
    firecrawlRequests: 0, firecrawlFailures: 0,
    openaiCostUsd: 0, serperCostUsd: 0, firecrawlCostUsd: 0, totalCostUsd: 0
  });

  const perUpload = new Map();
  for (const run of perRun) {
    const key = run.uploadId || '(no uploadId)';
    const existing = perUpload.get(key) || { uploadId: key, runs: 0, accountsAttempted: 0, totalCostUsd: 0, signalsProduced: 0 };
    existing.runs += 1;
    existing.accountsAttempted += run.accountsAttempted;
    existing.totalCostUsd = round4(existing.totalCostUsd + run.totalCostUsd);
    existing.signalsProduced += run.signalsProduced;
    perUpload.set(key, existing);
  }

  const avgUsagePerSuccessfulAccount = totals.accountsWithSignals > 0 ? {
    openaiInputTokens: round1(totals.openaiInputTokens / totals.accountsWithSignals),
    openaiOutputTokens: round1(totals.openaiOutputTokens / totals.accountsWithSignals),
    serperQueries: round1(totals.serperQueries / totals.accountsWithSignals),
    firecrawlRequests: round1(totals.firecrawlRequests / totals.accountsWithSignals),
    costUsd: round4(totals.totalCostUsd / totals.accountsAttempted)
  } : null;

  // "Failed-account usage" -- runs that produced zero signals for at least
  // one account still incurred the SAME batched provider calls (there is no
  // per-account provider call to isolate; see the module-level limitation
  // note above), so this reports the usage/cost attributable to runs that
  // had at least one non-actionable account, not a truly isolated
  // per-account figure.
  const runsWithFailedAccounts = perRun.filter(r => r.accountsWithNoSignals > 0);
  const failedAccountUsage = {
    runsAffected: runsWithFailedAccounts.length,
    accountsWithNoSignals: runsWithFailedAccounts.reduce((s, r) => s + r.accountsWithNoSignals, 0),
    attributableCostUsd: round4(runsWithFailedAccounts.reduce((s, r) => s + r.totalCostUsd, 0))
  };

  return {
    perRun,
    perUpload: Array.from(perUpload.values()),
    totals: { ...totals, openaiCostUsd: round4(totals.openaiCostUsd), serperCostUsd: round4(totals.serperCostUsd), firecrawlCostUsd: round4(totals.firecrawlCostUsd), totalCostUsd: round4(totals.totalCostUsd) },
    avgUsagePerSuccessfulAccount,
    failedAccountUsage,
    costPerResearchedAccount: totals.accountsAttempted > 0 ? round4(totals.totalCostUsd / totals.accountsAttempted) : null,
    costPerActionableSignal: totals.signalsProduced > 0 ? round4(totals.totalCostUsd / totals.signalsProduced) : null
  };
}

function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

function printReport(result) {
  console.log('=== Provider Usage Report ===\n');
  console.log(`Runs measured:              ${result.totals.runs}`);
  console.log(`Accounts attempted (total): ${result.totals.accountsAttempted}`);
  console.log(`Accounts with signals:      ${result.totals.accountsWithSignals}`);
  console.log(`Accounts with no signals:   ${result.totals.accountsWithNoSignals}`);
  console.log(`Signals produced:           ${result.totals.signalsProduced}`);
  console.log(`Total elapsed ms:           ${result.totals.elapsedMs}`);
  console.log('');
  console.log('--- Usage per provider (totals) ---');
  console.log(`OpenAI:    ${result.totals.openaiCalls} calls, ${result.totals.openaiFailures} failures, ${result.totals.openaiInputTokens} input tokens, ${result.totals.openaiOutputTokens} output tokens, $${result.totals.openaiCostUsd}`);
  console.log(`Serper:    ${result.totals.serperQueries} queries, ${result.totals.serperFailedQueries} failed, $${result.totals.serperCostUsd}`);
  console.log(`Firecrawl: ${result.totals.firecrawlRequests} requests, ${result.totals.firecrawlFailures} failures, $${result.totals.firecrawlCostUsd}`);
  console.log('');
  console.log(`Total estimated provider cost: $${result.totals.totalCostUsd}`);
  console.log(`Cost per researched account:   ${result.costPerResearchedAccount === null ? 'n/a' : '$' + result.costPerResearchedAccount}`);
  console.log(`Cost per actionable signal:    ${result.costPerActionableSignal === null ? 'n/a' : '$' + result.costPerActionableSignal}`);
  console.log('');
  console.log('--- Average usage per successful (signal-producing) account (approximate -- see limitation note) ---');
  console.log(result.avgUsagePerSuccessfulAccount ? JSON.stringify(result.avgUsagePerSuccessfulAccount, null, 2) : '  (no accounts with signals in this log window)');
  console.log('');
  console.log('--- Failed-account usage (runs with at least one non-actionable account) ---');
  console.log(JSON.stringify(result.failedAccountUsage, null, 2));
  console.log('');
  console.log('--- Usage per upload ---');
  console.table(result.perUpload);
  console.log('');
  console.log('--- Usage per research run ---');
  console.table(result.perRun.map(r => ({
    uploadId: r.uploadId, researchRunId: r.researchRunId, mode: r.mode,
    accounts: r.accountsAttempted, signals: r.signalsProduced,
    openaiTokens: r.openaiInputTokens + r.openaiOutputTokens,
    serperQueries: r.serperQueries, firecrawlReqs: r.firecrawlRequests,
    costUsd: r.totalCostUsd
  })));
}

async function main() {
  const filePath = process.argv[2];
  const input = filePath ? (await import('fs')).createReadStream(filePath) : process.stdin;
  const records = await readUsageRecords(input);
  if (!records.length) {
    console.error('No provider-usage log records found in the given input. Nothing to aggregate.');
    process.exitCode = 1;
    return;
  }
  const result = aggregate(records);
  printReport(result);
}

// Only run when invoked directly (node scripts/aggregate-provider-usage.js), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
