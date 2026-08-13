// Security correction sprint (pre-Beta), item 4b: deterministic coverage
// that server-only secret access remains server-only. Scans every
// browser-delivered file (root/*.html, dashboard/, prospects/, admin/,
// export-guides/, and the standalone root-level *.js files actually served
// to a browser) for two failure modes:
//   1. a literal reference to a server-only secret env var name -- these
//      must only ever be read inside api/*.js via process.env, never
//      embedded in anything shipped to a browser.
//   2. any Supabase client SDK usage (supabase-js / createClient / an
//      anon/publishable key) -- this app has no browser-side Supabase
//      client at all; every ha_* table access goes through api/*.js using
//      the service-role key, so RLS having zero policies is not currently
//      exploitable. If a browser-side Supabase client is ever introduced,
//      this test intentionally fails until RLS policies are added.
//
// Usage: node scripts/test-server-secrets-not-exposed.js
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// Server-only secrets: must never appear as a literal string in anything
// served to a browser. (SUPABASE_URL, ADMIN_EMAIL, etc. are intentionally
// excluded -- they are not secrets.)
const SERVER_ONLY_SECRET_ENV_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
  'SERPER_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'TAVILY_API_KEY',
  'FIRECRAWL_API_KEY',
  'CRON_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY'
];

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'api', 'scripts', '.vercel']);

function listBrowserFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listBrowserFiles(full));
    } else if (['.html', '.js'].includes(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

const browserFiles = listBrowserFiles(ROOT);
assert(browserFiles.length > 10, `discovered a plausible number of browser-delivered files to scan (found ${browserFiles.length})`);

for (const file of browserFiles) {
  const relPath = file.replace(ROOT, '');
  const content = readFileSync(file, 'utf8');

  for (const secretName of SERVER_ONLY_SECRET_ENV_VARS) {
    assert(!content.includes(secretName), `REQUIRED: ${relPath} does not reference the server-only secret name "${secretName}"`);
  }
}

// No browser-side Supabase client SDK anywhere -- this is the reason RLS
// having zero policies is not currently exploitable (see the security audit).
// If this ever fires, it means a browser-side Supabase client was added and
// RLS policies must be written before that ships.
const SUPABASE_CLIENT_PATTERNS = [/supabase-js/i, /createClient\s*\(/, /SUPABASE_ANON_KEY/i, /NEXT_PUBLIC_SUPABASE/i];
for (const file of browserFiles) {
  const relPath = file.replace(ROOT, '');
  const content = readFileSync(file, 'utf8');
  const matched = SUPABASE_CLIENT_PATTERNS.some(re => re.test(content));
  assert(!matched, `REQUIRED: ${relPath} does not load a browser-side Supabase client SDK (no anon/publishable key path exists to protect via RLS)`);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
