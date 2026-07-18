import fs from 'node:fs';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const batch=read('api/research-batch.js'), weekly=read('api/weekly-scan.js'), monitoring=read('api/monitoring-lists.js'), dashboard=read('dashboard/index.html');
const checks=[
 ['batch no 50-account hard cap', !batch.includes('.slice(0, 50);')],
 ['weekly loads full upload', weekly.includes('limit=5000')],
 ['weekly chunks full book', weekly.includes('WEEKLY_RESEARCH_BATCH_SIZE')],
 ['structured instrumentation', batch.includes('structuredSummary')],
 ['account pause API', monitoring.includes('pause-account')],
 ['safe delete wording', dashboard.includes('Delete Account Data')],
 ['management action restored', dashboard.includes('Manage Customer Accounts')],
 ['diagnostics hidden', dashboard.includes("renderResearchDiagnostics(){ const el=document.getElementById('researchDiagnosticsPanel')")],
 ['Gallagher fixture', fs.existsSync(new URL('../benchmarks/arthur-j-gallagher.json', import.meta.url))]
];
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)process.exitCode=1}
