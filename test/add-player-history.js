// ============================================================
// Focused tests: Add Player + Player History (multi-owner money)
// Run: node test/add-player-history.js
// ============================================================

let BASE;
try {
  const cfg = require('../config.js');
  BASE = process.env.CRICKET_TEST_API_URL || cfg.CRICKET_TEST_API_URL || cfg.CRICKET_API_URL;
} catch (e) {
  BASE = process.env.CRICKET_TEST_API_URL || process.env.CRICKET_API_URL || '';
}
if (!BASE || BASE.includes('YOUR_APPS_SCRIPT')) {
  console.error('ERROR: Set CRICKET_API_URL in config.js (copy from config.example.js)');
  process.exit(1);
}

let ADMIN_TOKEN;
try {
  const cfg = require('../config.js');
  ADMIN_TOKEN = process.env.CRICKET_ADMIN_TOKEN || cfg.CRICKET_ADMIN_TOKEN || '';
} catch (e) {
  ADMIN_TOKEN = process.env.CRICKET_ADMIN_TOKEN || '';
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

const WRITE_ACTIONS = new Set(['removePlayer', 'lockMatch', 'deleteMatch', 'setPlayerAmount', 'renamePlayer', 'deletePlayer']);

function trackCreate(result) {
  if (result?.matchId && result?.writeToken) {
    writeTokens[result.matchId] = result.writeToken;
  }
}

async function post(body) {
  const payload = { ...body };
  if (payload.matchId && WRITE_ACTIONS.has(payload.action) && writeTokens[payload.matchId]) {
    if (!payload.writeToken) payload.writeToken = writeTokens[payload.matchId];
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
    if (payload.action === 'createMatch') trackCreate(result);
    return result;
  }
  catch (e) { return { error: `Non-JSON (HTTP ${r.status}): ${text.substring(0, 120)}` }; }
}

async function postRaw(body) {
  const r = await fetch(BASE, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { return { error: `Non-JSON (HTTP ${r.status}): ${text.substring(0, 120)}` }; }
}

async function postAdmin(body) {
  return post({ ...body, writeToken: ADMIN_TOKEN });
}

async function run() {
  console.log('\n🏏 Add Player + Multi-Owner History Tests\n');

  // ── BLOCK X: Add Player ──
  console.log('── X1. Add player with empty name rejected');
  const addEmpty = await post({ action: 'addPlayer', playerName: '' });
  assert('Empty name rejected', !!addEmpty.error, JSON.stringify(addEmpty));

  const addMissing = await post({ action: 'addPlayer' });
  assert('Missing name rejected', !!addMissing.error, JSON.stringify(addMissing));

  console.log('\n── X2. Add new player succeeds');
  const addOk = await post({ action: 'addPlayer', playerName: 'TestPreReg' });
  assert('addPlayer succeeds', addOk.success === true, JSON.stringify(addOk));
  assert('Returns playerName', addOk.playerName === 'TestPreReg');
  assert('Returns playerId', !!addOk.playerId);

  console.log('\n── X3. Duplicate add rejected (same case)');
  const addDup = await post({ action: 'addPlayer', playerName: 'TestPreReg' });
  assert('Duplicate rejected', !!addDup.error && addDup.error.includes('already exists'), JSON.stringify(addDup));

  console.log('\n── X4. Duplicate add rejected (different case)');
  const addDupCase = await post({ action: 'addPlayer', playerName: 'testprereg' });
  assert('Case-insensitive dup rejected', !!addDupCase.error && addDupCase.error.includes('already exists'), JSON.stringify(addDupCase));

  console.log('\n── X5. Pre-added player appears in getPlayers()');
  const rosterX = await get('players');
  const preRegPlayer = rosterX.players?.find(p => p.name === 'TestPreReg');
  assert('Player in roster', !!preRegPlayer);
  assert('Has 0 matches', preRegPlayer?.matches === 0, `got ${preRegPlayer?.matches}`);
  assert('Has 0 outstanding', preRegPlayer?.outstanding === 0, `got ${preRegPlayer?.outstanding}`);

  console.log('\n── X6. Check-in pre-added player — no duplicate in Players sheet');
  const cPreReg = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'Test', payToUPI: 'test@upi' });
  createdMatchIds.push(cPreReg.matchId);
  const ciPreReg = await post({ action: 'checkIn', matchId: cPreReg.matchId, playerName: 'TestPreReg' });
  assert('Check-in succeeds', ciPreReg.success === true, JSON.stringify(ciPreReg));

  const rosterX2 = await get('players');
  const preRegEntries = rosterX2.players?.filter(p => p.name === 'TestPreReg');
  assert('No duplicate in roster', preRegEntries?.length === 1, `got ${preRegEntries?.length} entries`);
  assert('Now has 1 match', preRegEntries?.[0]?.matches === 1, `got ${preRegEntries?.[0]?.matches}`);

  const preRegId = preRegEntries?.[0]?.playerId;

  // ── BLOCK Y: Player History ──
  console.log('\n── Y1. playerHistory with missing ID returns error');
  const histNoId = await get('playerHistory');
  assert('Missing ID returns error', !!histNoId.error, JSON.stringify(histNoId));

  console.log('\n── Y2. playerHistory with fake ID returns error');
  const histFake = await get('playerHistory', { id: 'FAKE_PLAYER_999' });
  assert('Fake ID returns error', !!histFake.error, JSON.stringify(histFake));

  console.log('\n── Y3. playerHistory for TestPreReg returns match history');
  const histOk = await get('playerHistory', { id: preRegId });
  assert('Returns playerId', histOk.playerId === preRegId);
  assert('Returns name', histOk.name === 'TestPreReg');
  assert('History is array', Array.isArray(histOk.history));
  assert('Has 1 history entry', histOk.history?.length === 1, `got ${histOk.history?.length}`);

  console.log('\n── Y4. History entry has correct fields');
  const entry = histOk.history?.[0];
  assert('Entry has matchId', entry?.matchId === cPreReg.matchId);
  assert('Entry has date', entry?.date === '2026-06-08');
  assert('Entry has payTo', entry?.payTo === 'Test');
  assert('Entry has amount (number)', typeof entry?.amount === 'number');
  assert('Entry has paid (boolean)', typeof entry?.paid === 'boolean');

  console.log('\n── Y5. Lock match and verify amount in history');
  await post({ action: 'lockMatch', matchId: cPreReg.matchId, totalCost: 600 });
  const histAfterLock = await get('playerHistory', { id: preRegId });
  const entryAfterLock = histAfterLock.history?.find(h => h.matchId === cPreReg.matchId);
  assert('Amount updated after lock', entryAfterLock?.amount === 600, `got ${entryAfterLock?.amount}`);

  console.log('\n── Y6. Mark paid and verify in history');
  await postRaw({ action: 'markPaid', matchId: cPreReg.matchId, playerName: 'TestPreReg', paid: true });
  const histAfterPaid = await get('playerHistory', { id: preRegId });
  const entryAfterPaid = histAfterPaid.history?.find(h => h.matchId === cPreReg.matchId);
  assert('paid = true in history', entryAfterPaid?.paid === true, `got ${entryAfterPaid?.paid}`);

  // ── BLOCK Z: Multi-owner money (player owes different admins) ──
  console.log('\n── Z1. Setup second match with different owner (OwnerB)');
  const cOwnerB = await post({ action: 'createMatch', date: '2026-06-09', payTo: 'OwnerB', payToUPI: 'ob@upi' });
  createdMatchIds.push(cOwnerB.matchId);
  await post({ action: 'checkIn', matchId: cOwnerB.matchId, playerName: 'TestPreReg' });
  await post({ action: 'lockMatch', matchId: cOwnerB.matchId, totalCost: 400 });

  console.log('\n── Z2. Aggregated stats show total owed across both owners');
  const rosterMulti = await get('players');
  const multiPlayer = rosterMulti.players?.find(p => p.name === 'TestPreReg');
  assert('Has 2 matches', multiPlayer?.matches === 2, `got ${multiPlayer?.matches}`);
  assert('Total owed = 1000 (600+400)', multiPlayer?.totalOwed === 1000, `got ${multiPlayer?.totalOwed}`);
  assert('Total paid = 600 (only first match paid)', multiPlayer?.totalPaid === 600, `got ${multiPlayer?.totalPaid}`);
  assert('Outstanding = 400', multiPlayer?.outstanding === 400, `got ${multiPlayer?.outstanding}`);

  console.log('\n── Z3. History shows both owners with correct payTo');
  const histMulti = await get('playerHistory', { id: preRegId });
  assert('History has 2 entries', histMulti.history?.length === 2, `got ${histMulti.history?.length}`);

  const payTos = (histMulti.history || []).map(h => h.payTo).sort();
  assert('payTo includes Test and OwnerB', payTos.includes('Test') && payTos.includes('OwnerB'), JSON.stringify(payTos));

  const ownerBEntry = histMulti.history?.find(h => h.payTo === 'OwnerB');
  assert('OwnerB entry amount = 400', ownerBEntry?.amount === 400, `got ${ownerBEntry?.amount}`);
  assert('OwnerB entry unpaid', ownerBEntry?.paid === false, `got ${ownerBEntry?.paid}`);

  const testEntry = histMulti.history?.find(h => h.payTo === 'Test');
  assert('Test entry amount = 600', testEntry?.amount === 600, `got ${testEntry?.amount}`);
  assert('Test entry paid', testEntry?.paid === true, `got ${testEntry?.paid}`);

  // ── Summary ──
  const total = passed + failed;
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) console.log('🎉 All focused tests passed!\n');
  else console.log('⚠️  Some tests failed — see ❌ above.\n');

  if (ADMIN_TOKEN && !process.env.CRICKET_SKIP_CLEANUP) {
    console.log('🗑️  Purging test data...');
    const purge = await postAdmin({ action: 'purgeTestData' });
    if (purge.error) console.log(`   ⚠️  Purge failed: ${purge.error}`);
    else console.log(`   ✅ ${purge.matchesDeleted || 0} match(es), ${purge.playersDeleted || 0} player(s) removed`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('\nFatal error:', err.message); process.exit(1); });
