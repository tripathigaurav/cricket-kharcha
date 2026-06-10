#!/usr/bin/env node
// Purge integration-test matches + players via admin API (no Apps Script editor needed).
// Run: npm run test:cleanup  (or node test/cleanup.js)

let BASE, ADMIN_TOKEN;
try {
  const cfg = require('../config.js');
  BASE = process.env.CRICKET_TEST_API_URL || cfg.CRICKET_TEST_API_URL || cfg.CRICKET_API_URL;
  ADMIN_TOKEN = process.env.CRICKET_ADMIN_TOKEN || cfg.CRICKET_ADMIN_TOKEN || '';
} catch (e) {
  console.error('Need config.js (copy from config.example.js)');
  process.exit(1);
}

async function post(body) {
  const r = await fetch(BASE, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { return { error: `Non-JSON: ${text.substring(0, 120)}` }; }
}

async function main() {
  if (!ADMIN_TOKEN) {
    console.error('Set CRICKET_ADMIN_TOKEN (e.g. admin_009 in config.js)');
    process.exit(1);
  }

  console.log('\n🧹 CricTracker — purge test data\n');

  const result = await post({ action: 'purgeTestData', writeToken: ADMIN_TOKEN });

  if (result.error) {
    if (result.error.includes('Unknown action')) {
      console.error('❌ Backend missing purgeTestData — paste latest Code.gs and deploy a new version.');
    } else {
      console.error('❌', result.error);
    }
    process.exit(1);
  }

  console.log(`✅ Matches removed:  ${result.matchesDeleted || 0}`);
  console.log(`✅ Payments removed: ${result.paymentsDeleted || 0}`);
  console.log(`✅ Players removed:  ${result.playersDeleted || 0}`);

  const kept = result.keptMatches || [];
  if (kept.length) {
    console.log(`\nKept ${kept.length} real match(es):`);
    kept.forEach(m => console.log(`  · ${m.date} — ${m.payTo}`));
  } else {
    console.log('\nNo real matches left on sheet.');
  }
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
