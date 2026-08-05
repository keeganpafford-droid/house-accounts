// Commercial-readiness core validation, item 1: provider pricing inputs,
// deliberately kept separate from the usage-measurement code (which only
// counts calls/tokens/queries/credits and never assumes a price). Update
// these constants as actual vendor rates change or are confirmed -- nothing
// in api/research-batch.js or scripts/aggregate-provider-usage.js needs to
// change when a price changes, only this file.
//
// Sources: OpenAI/Serper/Firecrawl public pricing pages as of the beta
// planning window. CONFIRM against the current vendor pricing page and the
// account's actual plan/volume tier before using these for a real pricing
// decision -- they are a starting estimate, not a verified invoice.
export const PROVIDER_PRICING = {
  openai: {
    // $ per 1,000 tokens, gpt-4o-mini list pricing. If OPENAI_MODEL is
    // overridden to a different model in a given environment, update this
    // (or add a per-model entry) before trusting the cost estimate.
    model: 'gpt-4o-mini',
    inputPer1kTokens: 0.00015,
    outputPer1kTokens: 0.0006
  },
  serper: {
    // Serper's standard pay-as-you-go rate is priced per 1,000 queries.
    perQuery: 0.001
  },
  firecrawl: {
    // Firecrawl bills in "credits"; one /scrape request is commonly 1
    // credit on the standard plan. If the account is on a different plan
    // or Firecrawl's credit-per-scrape ratio changes, update this.
    perRequest: 0.002
  }
};

// Given a providerUsage.run/openai/serper/firecrawl object shape (see
// api/research-batch.js's providerUsage construction), returns the
// estimated cost in US dollars for that one run. Never throws on partial/
// missing fields -- a benchmark run may be missing a provider's usage
// entirely (e.g. Firecrawl not configured), which must estimate as $0 for
// that provider, not crash the aggregation.
export function estimateRunCostUsd(usage = {}, pricing = PROVIDER_PRICING) {
  const openaiInputTokens = Number(usage?.openai?.inputTokens || 0);
  const openaiOutputTokens = Number(usage?.openai?.outputTokens || 0);
  const openaiCost =
    (openaiInputTokens / 1000) * pricing.openai.inputPer1kTokens +
    (openaiOutputTokens / 1000) * pricing.openai.outputPer1kTokens;
  const serperCost = Number(usage?.serper?.queries || 0) * pricing.serper.perQuery;
  const firecrawlCost = Number(usage?.firecrawl?.requests || 0) * pricing.firecrawl.perRequest;
  return {
    openaiCostUsd: round4(openaiCost),
    serperCostUsd: round4(serperCost),
    firecrawlCostUsd: round4(firecrawlCost),
    totalCostUsd: round4(openaiCost + serperCost + firecrawlCost)
  };
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}
