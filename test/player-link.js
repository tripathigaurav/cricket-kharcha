// Player link: mark paid on/off without write token
let BASE;
try {
  const cfg = require('../config.js');
  BASE = process.env.CRICKET_TEST_API_URL || cfg.CRICKET_TEST_API_URL || cfg.CRICKET_API_URL;
} catch (e) {
  BASE = process.env.CRICKET_API_URL || '';
}

async function get(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const r = await fetch(`${BASE}?${qs}`, { redirect: 'follow' });
  return JSON.parse(await r.text());
}

async function post(body, token) {
  const payload = { ...body };
  if (token) payload.writeToken = token;
  const r = await fetch(BASE, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  });
  return JSON.parse(await r.text());
}

function assert(label, ok, detail = '') {
  console.log(ok ? `  ✅ ${label}` : `  ❌ ${label}${detail ? ' — ' + detail : ''}`);
  return ok;
}

async function run() {
  console.log('\n🏏 Player link — mark paid on/off\n');

  const created = await post({ action: 'createMatch', date: '2026-06-08', payTo: 'Admin', payToUPI: 'admin@upi' });
  if (!created.matchId) {
    console.error('createMatch failed', created);
    process.exit(1);
  }
  const matchId = created.matchId;
  const token = created.writeToken;

  await post({ action: 'checkIn', matchId, playerName: 'TestPlayer' }, token);
  await post({ action: 'lockMatch', matchId, totalCost: 1000 }, token);

  const markOnPlayer = await post({ action: 'markPaid', matchId, playerName: 'TestPlayer', paid: true });
  assert('Player link marks paid ON (no token)', markOnPlayer.success === true, JSON.stringify(markOnPlayer));

  let m1 = await get('match', { id: matchId });
  assert('Paid is true', m1.match?.players?.[0]?.paid === true);

  const markOffNoToken = await post({ action: 'markPaid', matchId, playerName: 'TestPlayer', paid: false });
  assert('Player link un-mark rejected (no token)', !!markOffNoToken.error, JSON.stringify(markOffNoToken));

  const m1b = await get('match', { id: matchId });
  assert('Still paid after rejected un-mark', m1b.match?.players?.[0]?.paid === true);

  const markOffWithToken = await post({ action: 'markPaid', matchId, playerName: 'TestPlayer', paid: false }, token);
  assert('Admin un-mark succeeds (with token)', markOffWithToken.success === true, JSON.stringify(markOffWithToken));

  const m2 = await get('match', { id: matchId });
  assert('Paid is false after admin un-mark', m2.match?.players?.[0]?.paid === false);

  const lockNoToken = await post({ action: 'lockMatch', matchId, totalCost: 2000 });
  assert('Player link still cannot lock cost', !!lockNoToken.error);

  await post({ action: 'deleteMatch', matchId }, token);
  console.log('\nDone.\n');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
