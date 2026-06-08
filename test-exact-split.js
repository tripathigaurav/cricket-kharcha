// Run only custom split (exact mode) tests: node test-exact-split.js
let BASE;
try {
  const cfg = require('./config.js');
  BASE = process.env.CRICKET_TEST_API_URL || cfg.CRICKET_TEST_API_URL || cfg.CRICKET_API_URL;
} catch (e) {
  BASE = process.env.CRICKET_TEST_API_URL || process.env.CRICKET_API_URL || '';
}
if (!BASE || BASE.includes('YOUR_APPS_SCRIPT')) {
  console.error('ERROR: Set CRICKET_API_URL in config.js');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const createdMatchIds = [];
const writeTokens = {};

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function get(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const r = await fetch(`${BASE}?${qs}`, { redirect: 'follow' });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { return { error: `Non-JSON (HTTP ${r.status}): ${text.substring(0, 120)}` }; }
}

const WRITE_ACTIONS = new Set(['removePlayer', 'lockMatch', 'markPaid', 'deleteMatch', 'setPlayerAmount']);

async function post(body) {
  const payload = { ...body };
  if (payload.matchId && WRITE_ACTIONS.has(payload.action) && writeTokens[payload.matchId]) {
    payload.writeToken = writeTokens[payload.matchId];
  }
  const r = await fetch(BASE, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  try {
    const result = JSON.parse(text);
    if (payload.action === 'createMatch' && result?.matchId && result?.writeToken) {
      writeTokens[result.matchId] = result.writeToken;
    }
    return result;
  } catch (e) {
    return { error: `Non-JSON (HTTP ${r.status}): ${text.substring(0, 120)}` };
  }
}

async function run() {
  console.log('\n🏏 Custom split (exact mode) tests only\n');

  console.log('── D7. Custom split — exact mode');
  const cExact = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'ExactAdmin', payToUPI: 'exact@upi' });
  if (!cExact.matchId) {
    console.error('  ❌ createMatch failed:', JSON.stringify(cExact));
    process.exit(1);
  }
  createdMatchIds.push(cExact.matchId);
  const exactId = cExact.matchId;

  await post({ action: 'checkIn', matchId: exactId, playerName: 'A' });
  await post({ action: 'checkIn', matchId: exactId, playerName: 'B' });
  await post({ action: 'checkIn', matchId: exactId, playerName: 'C' });

  const lockExact = await post({ action: 'lockMatch', matchId: exactId, totalCost: 5000, splitMode: 'exact' });
  assert('Exact lock succeeds', lockExact.success === true, JSON.stringify(lockExact));
  assert('splitMode is exact', lockExact.splitMode === 'exact', `got ${lockExact.splitMode}`);

  await post({ action: 'setPlayerAmount', matchId: exactId, playerName: 'A', amountOwed: 2000 });
  await post({ action: 'setPlayerAmount', matchId: exactId, playerName: 'B', amountOwed: 2000 });
  const setC = await post({ action: 'setPlayerAmount', matchId: exactId, playerName: 'C', amountOwed: 1000 });
  assert('setPlayerAmount succeeds', setC.success === true, JSON.stringify(setC));
  assert('assigned = 5000', setC.assigned === 5000, `got ${setC.assigned}`);

  const mExact = await get('match', { id: exactId });
  assert('splitMode exact on getMatch', mExact.match?.splitMode === 'exact', `got ${mExact.match?.splitMode}`);
  assert('A owes 2000', mExact.match?.players?.find(p => p.name === 'A')?.amountOwed === 2000);
  assert('B owes 2000', mExact.match?.players?.find(p => p.name === 'B')?.amountOwed === 2000);
  assert('C owes 1000', mExact.match?.players?.find(p => p.name === 'C')?.amountOwed === 1000);

  await post({ action: 'markPaid', matchId: exactId, playerName: 'A', paid: true });
  const mPaid = await get('match', { id: exactId });
  assert('paidAmount = 2000 (not equal share)', mPaid.match?.paidAmount === 2000, `got ${mPaid.match?.paidAmount}`);

  await post({ action: 'checkIn', matchId: exactId, playerName: 'D' });
  const mAfterD = await get('match', { id: exactId });
  assert('B still owes 2000 after check-in', mAfterD.match?.players?.find(p => p.name === 'B')?.amountOwed === 2000);
  assert('C still owes 1000 after check-in', mAfterD.match?.players?.find(p => p.name === 'C')?.amountOwed === 1000);
  assert('D gets 0 in exact mode', mAfterD.match?.players?.find(p => p.name === 'D')?.amountOwed === 0);

  const toEqual = await post({ action: 'lockMatch', matchId: exactId, totalCost: 5000, splitMode: 'equal' });
  assert('Switch to equal succeeds', toEqual.success === true, JSON.stringify(toEqual));
  assert('splitMode is equal', toEqual.splitMode === 'equal', `got ${toEqual.splitMode}`);
  const mEqual = await get('match', { id: exactId });
  const expectedEqual = Math.ceil(5000 / 4);
  assert('All owe equal split after switch', mEqual.match?.players?.every(p => p.amountOwed === expectedEqual), `expected ${expectedEqual}`);

  console.log(`\nResults: ${passed}/${passed + failed} passed`);
  console.log(`🗑️  Cleaning up ${createdMatchIds.length} test match...`);
  for (const id of createdMatchIds) {
    await post({ action: 'deleteMatch', matchId: id });
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
