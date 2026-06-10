// CricHeroes scrape test only: node test-cricheroes.js [optional-url]
let BASE;
try {
  const cfg = require('../config.js');
  BASE = process.env.CRICKET_TEST_API_URL || cfg.CRICKET_TEST_API_URL || cfg.CRICKET_API_URL;
} catch (e) {
  BASE = process.env.CRICKET_API_URL || '';
}
if (!BASE || BASE.includes('YOUR_APPS_SCRIPT')) {
  console.error('ERROR: Set CRICKET_API_URL in config.js');
  process.exit(1);
}

const DEFAULT_URL =
  'https://cricheroes.in/scorecard/25310473/durga-league---2026/dp-dhurandhar-vs-original-gang-(og)';
const TEST_URL = process.argv[2] || DEFAULT_URL;

async function get(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const r = await fetch(`${BASE}?${qs}`, { redirect: 'follow' });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { return { error: `Non-JSON: ${text.substring(0, 150)}` }; }
}

function ok(label, pass, detail = '') {
  console.log(pass ? `  ✅ ${label}` : `  ❌ ${label}${detail ? ' — ' + detail : ''}`);
  return pass;
}

async function run() {
  console.log('\n🏏 CricHeroes scrape test\n');
  console.log(`URL: ${TEST_URL}\n`);

  console.log('── 1. Live scrape');
  const t0 = Date.now();
  const scrape = await get('scrape', { url: TEST_URL });
  const ms = Date.now() - t0;

  if (scrape.error) {
    ok('API responded without fatal error', false, scrape.error);
    process.exit(1);
  }

  ok('Returns players array', Array.isArray(scrape.players), JSON.stringify(scrape).slice(0, 200));
  const n = scrape.players?.length || 0;
  console.log(`     Players found: ${n}`);
  console.log(`     Source: ${scrape.source || 'n/a'} | HTML length: ${scrape.htmlLength ?? 'n/a'} | ${ms}ms`);

  if (n > 0) {
    console.log(`     Sample: ${scrape.players.slice(0, 8).map(p => p.name).join(', ')}${n > 8 ? '…' : ''}`);
    ok('Player objects have names', scrape.players.every(p => typeof p.name === 'string' && p.name.length > 0));
  } else {
    console.log('     ⚠️  0 players — CricHeroes may be blocking Apps Script (bot detection)');
  }

  console.log('\n── 2. Edge cases');
  const bad = await get('scrape', { url: 'https://example.com/evil' });
  ok('Non-CricHeroes URL blocked (empty players)', Array.isArray(bad.players) && bad.players.length === 0);

  const noUrl = await get('scrape', {});
  ok('Missing URL returns error', !!noUrl.error);

  console.log('\n' + (n > 0 ? '✅ Scrape working — players returned' : '⚠️  API OK but 0 players — try another scorecard URL') + '\n');
  process.exit(n > 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
