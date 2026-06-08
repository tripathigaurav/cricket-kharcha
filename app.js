// ============================================================
// Cricket Kharcha — Frontend App
// ============================================================

const API_URL = 'https://script.google.com/macros/s/AKfycbyKXOQOsxEcwMQzLagw_VdG1iueTdnqa2JMqcrWzSe8c8kN69iR541FVKmEiyepli3f1w/exec';

const IS_DEMO = API_URL.includes('YOUR_APPS_SCRIPT');

// --- State ---
let currentMatchId = null;

// --- Demo Mode (in-memory mock backend) ---
const _demo = {
  matches: [
    { matchId: 'demo1', date: new Date().toISOString().split('T')[0], cricheroes: '', totalCost: 0, perPlayerCost: 0, playerCount: 0, payTo: 'Gaurav', payToUPI: 'gaurav@upi', status: 'checkin', paidCount: 0, paidAmount: 0 },
    { matchId: 'demo0', date: '2026-05-31', cricheroes: '', totalCost: 3600, perPlayerCost: 200, playerCount: 18, payTo: 'Gaurav', payToUPI: 'gaurav@upi', status: 'locked', paidCount: 15, paidAmount: 3000 }
  ],
  payments: {
    demo1: [],
    demo0: [
      { name: 'Shubham', playerId: 'p1', amountOwed: 200, paid: true, paidTimestamp: '2026-05-31T10:00:00Z' },
      { name: 'Prashant', playerId: 'p2', amountOwed: 200, paid: true, paidTimestamp: '2026-05-31T10:05:00Z' },
      { name: 'Shivam', playerId: 'p3', amountOwed: 200, paid: true, paidTimestamp: '2026-05-31T10:10:00Z' },
      { name: 'Adwitiya', playerId: 'p4', amountOwed: 200, paid: false, paidTimestamp: '' },
      { name: 'Prabhu', playerId: 'p5', amountOwed: 200, paid: false, paidTimestamp: '' },
      { name: 'Jalpan', playerId: 'p6', amountOwed: 200, paid: false, paidTimestamp: '' }
    ]
  },
  nextId: () => Date.now().toString(36)
};

function demoApi(action, params) {
  switch (action) {
    case 'matches':
      return { matches: _demo.matches.map(m => ({ ...m, playerCount: (_demo.payments[m.matchId] || []).length, paidCount: (_demo.payments[m.matchId] || []).filter(p => p.paid).length, paidAmount: (_demo.payments[m.matchId] || []).filter(p => p.paid).reduce((s, p) => s + p.amountOwed, 0) })) };
    case 'match': {
      const m = _demo.matches.find(x => x.matchId === params.id);
      if (!m) return { error: 'Match not found' };
      const players = _demo.payments[m.matchId] || [];
      return { match: { ...m, playerCount: players.length, paidCount: players.filter(p => p.paid).length, paidAmount: players.filter(p => p.paid).reduce((s, p) => s + p.amountOwed, 0), players } };
    }
    case 'players': {
      const stats = {};
      Object.values(_demo.payments).flat().forEach(p => {
        const k = p.name.toLowerCase();
        if (!stats[k]) stats[k] = { name: p.name, matches: 0, totalOwed: 0, totalPaid: 0 };
        stats[k].matches++; stats[k].totalOwed += p.amountOwed;
        if (p.paid) stats[k].totalPaid += p.amountOwed;
      });
      return { players: Object.values(stats).map(p => ({ ...p, outstanding: p.totalOwed - p.totalPaid })) };
    }
    case 'createMatch': {
      const id = _demo.nextId();
      _demo.matches.unshift({ matchId: id, date: params.date, cricheroes: '', totalCost: 0, perPlayerCost: 0, playerCount: 0, payTo: params.payTo, payToUPI: params.payToUPI, status: 'checkin', paidCount: 0, paidAmount: 0 });
      _demo.payments[id] = [];
      return { success: true, matchId: id };
    }
    case 'checkIn': {
      const list = _demo.payments[params.matchId];
      if (!list) return { error: 'Match not found' };
      if (list.find(p => p.name.toLowerCase() === params.playerName.toLowerCase())) return { error: 'Already checked in' };
      list.push({ name: params.playerName, playerId: _demo.nextId(), amountOwed: 0, paid: false, paidTimestamp: '' });
      return { success: true, playerName: params.playerName };
    }
    case 'removePlayer': {
      const list = _demo.payments[params.matchId];
      if (!list) return { error: 'Match not found' };
      const idx = list.findIndex(p => p.name.toLowerCase() === params.playerName.toLowerCase());
      if (idx === -1) return { error: 'Player not found' };
      list.splice(idx, 1);
      return { success: true };
    }
    case 'lockMatch': {
      const m = _demo.matches.find(x => x.matchId === params.matchId);
      if (!m) return { error: 'Match not found' };
      const players = _demo.payments[params.matchId] || [];
      if (players.length === 0) return { error: 'No players checked in' };
      const perPlayerCost = Math.ceil(params.totalCost / players.length);
      m.totalCost = params.totalCost; m.perPlayerCost = perPlayerCost; m.status = 'locked';
      players.forEach(p => p.amountOwed = perPlayerCost);
      return { success: true, perPlayerCost, playerCount: players.length };
    }
    case 'markPaid': {
      const list = _demo.payments[params.matchId];
      if (!list) return { error: 'Match not found' };
      const p = list.find(x => x.name.toLowerCase() === params.playerName.toLowerCase());
      if (!p) return { error: 'Player not found' };
      p.paid = params.paid !== false;
      p.paidTimestamp = p.paid ? new Date().toISOString() : '';
      return { success: true, paid: p.paid };
    }
    case 'scrape':
      return { error: 'CricHeroes scraping requires the live backend. Set up your Apps Script URL first.' };
    default:
      return { error: 'Unknown action: ' + action };
  }
}

// --- API Helper ---
async function api(action, params = {}, method = 'GET') {
  if (IS_DEMO) {
    await new Promise(r => setTimeout(r, 120)); // simulate network delay
    return demoApi(action, params);
  }
  try {
    let url;
    if (method === 'GET') {
      const qs = new URLSearchParams({ action, ...params }).toString();
      url = `${API_URL}?${qs}`;
      const resp = await fetch(url, { redirect: 'follow' });
      return await resp.json();
    } else {
      url = API_URL;
      const resp = await fetch(url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' }, // Apps Script needs text/plain to avoid CORS preflight
        body: JSON.stringify({ action, ...params })
      });
      return await resp.json();
    }
  } catch (err) {
    console.error('API error:', err);
    showToast('Network error. Please try again.', true);
    return { error: err.message };
  }
}

// --- Routing ---
function navigate(hash) {
  window.location.hash = hash;
}

function goBack() {
  navigate('#/');
}

function handleRoute() {
  const hash = window.location.hash || '#/';
  const views = document.querySelectorAll('.view');
  views.forEach(v => v.style.display = 'none');

  const backBtn = document.getElementById('btn-back');
  const statsBtn = document.getElementById('btn-stats');
  const title = document.getElementById('page-title');

  backBtn.style.display = 'none';
  statsBtn.style.display = '';
  title.textContent = '🏏 Cricket Kharcha';

  if (hash === '#/' || hash === '#' || hash === '') {
    document.getElementById('view-home').style.display = '';
    loadMatches();
  } else if (hash === '#/new') {
    document.getElementById('view-new').style.display = '';
    backBtn.style.display = '';
    title.textContent = 'New Match';
    document.getElementById('match-date').value = new Date().toISOString().split('T')[0];
  } else if (hash.startsWith('#/match/')) {
    document.getElementById('view-match').style.display = '';
    backBtn.style.display = '';
    title.textContent = 'Match';
    currentMatchId = hash.split('#/match/')[1];
    loadMatch(currentMatchId);
  } else if (hash === '#/stats') {
    document.getElementById('view-stats').style.display = '';
    backBtn.style.display = '';
    statsBtn.style.display = 'none';
    title.textContent = 'Player Stats';
    loadStats();
  }
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('DOMContentLoaded', () => {
  if (IS_DEMO) {
    const banner = document.getElementById('demo-banner');
    if (banner) banner.style.display = '';
  }
  handleRoute();
});

// --- Match List ---
async function loadMatches() {
  const listEl = document.getElementById('match-list');
  const emptyEl = document.getElementById('no-matches');
  listEl.innerHTML = '<div class="loading">Loading matches...</div>';
  emptyEl.style.display = 'none';

  const data = await api('matches');
  if (data.error) {
    listEl.innerHTML = `<div class="empty-state"><p>${data.error}</p></div>`;
    return;
  }

  const matches = data.matches || [];
  if (matches.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = '';
    return;
  }

  listEl.innerHTML = matches.map(m => {
    const hasCost = m.totalCost > 0;
    const pct = m.playerCount > 0 ? Math.round((m.paidCount / m.playerCount) * 100) : 0;
    const dateStr = formatDate(m.date);
    return `
      <div class="match-card" onclick="navigate('#/match/${m.matchId}')">
        <div class="match-card-top">
          <span class="match-card-date">${dateStr}</span>
          <span class="match-card-status ${hasCost ? 'status-locked' : 'status-checkin'}">
            ${hasCost ? '💰 ' + m.paidCount + '/' + m.playerCount + ' paid' : '📝 ' + m.playerCount + ' players'}
          </span>
        </div>
        <div class="match-card-bottom">
          <span class="match-card-cost">${hasCost ? '₹' + m.totalCost : 'No cost set'}</span>
          ${hasCost ? `
            <span class="match-card-progress">
              <span class="progress-bar"><span class="progress-fill" style="width:${pct}%"></span></span>
              ₹${m.paidAmount} collected
            </span>
          ` : `<span class="text-muted">${m.payTo ? 'Pay to: ' + m.payTo : ''}</span>`}
        </div>
      </div>
    `;
  }).join('');
}

// --- Create Match ---
async function handleCreateMatch() {
  const date = document.getElementById('match-date').value;
  const payTo = document.getElementById('pay-to').value.trim();
  const payToRaw = document.getElementById('pay-upi').value.trim();

  if (!date) return showToast('Please select a date', true);
  if (!payTo) return showToast('Please enter who to pay', true);
  if (!payToRaw) return showToast('Please enter a UPI ID or phone number', true);

  // Normalise: if it looks like a 10-digit phone number, convert to phone@upi
  const isPhone = /^[6-9]\d{9}$/.test(payToRaw);
  const payToUPI = isPhone ? payToRaw + '@upi' : payToRaw;

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Creating...';

  const data = await api('createMatch', { date, payTo, payToUPI }, 'POST');

  btn.disabled = false;
  btn.textContent = 'Create Match & Get Check-in Link';

  if (data.error) return showToast(data.error, true);

  showToast('Match created!');
  navigate(`#/match/${data.matchId}`);
}

// --- Load Match Detail (unified single-page) ---
let _currentMatch = null;
let _costSaveTimer = null;

async function loadMatch(matchId) {
  const loading = document.getElementById('match-loading');
  const body = document.getElementById('match-body');

  loading.style.display = '';
  body.style.display = 'none';

  const data = await api('match', { id: matchId });
  loading.style.display = 'none';

  if (data.error) {
    loading.style.display = '';
    loading.textContent = data.error;
    return;
  }

  _currentMatch = data.match;
  body.style.display = '';

  // Update page title with date
  document.getElementById('page-title').textContent = '📅 ' + formatDate(_currentMatch.date);

  // UPI pay banner — show only when cost is set
  const payBar = document.getElementById('payment-info-bar');
  if (_currentMatch.totalCost > 0 && _currentMatch.payTo) {
    payBar.style.display = '';
    document.getElementById('pay-amount-display').textContent =
      `Pay ₹${_currentMatch.perPlayerCost} to ${escapeHtml(_currentMatch.payTo)}`;
    const upiLink = document.getElementById('upi-link');
    if (_currentMatch.payToUPI) {
      const upiTn = encodeURIComponent('Cricket ' + formatDate(_currentMatch.date));
      upiLink.href = `upi://pay?pa=${encodeURIComponent(_currentMatch.payToUPI)}&am=${_currentMatch.perPlayerCost}&cu=INR&tn=${upiTn}`;
      upiLink.style.display = '';
    } else {
      upiLink.style.display = 'none';
    }
  } else {
    payBar.style.display = 'none';
  }

  // Cost input — set existing value
  const costInput = document.getElementById('total-cost');
  if (_currentMatch.totalCost > 0) costInput.value = _currentMatch.totalCost;
  updateSplitPreview();

  // Player count badge
  document.getElementById('player-count-badge').textContent =
    _currentMatch.players.length > 0 ? _currentMatch.players.length : '';

  renderPlayerList(_currentMatch);
  updateSummary(_currentMatch);

  // Wire cost input — auto-save after 1s pause
  costInput.oninput = () => {
    updateSplitPreview();
    clearTimeout(_costSaveTimer);
    _costSaveTimer = setTimeout(() => saveCost(), 1000);
  };
}

function updateSplitPreview() {
  const costInput = document.getElementById('total-cost');
  const cost = Number(costInput.value);
  const count = _currentMatch ? _currentMatch.players.length : 0;
  const preview = document.getElementById('split-preview');
  if (cost > 0 && count > 0) {
    preview.innerHTML = `<strong>₹${Math.ceil(cost / count)}</strong> per player (₹${cost} ÷ ${count})`;
  } else if (cost > 0) {
    preview.textContent = 'Add players to see the split';
  } else {
    preview.textContent = '';
  }
}

async function saveCost() {
  const cost = Number(document.getElementById('total-cost').value);
  if (!cost || cost <= 0 || !_currentMatch) return;
  const data = await api('lockMatch', { matchId: currentMatchId, totalCost: cost }, 'POST');
  if (data.error) return showToast(data.error, true);
  // Reload to refresh amounts and UPI bar
  loadMatch(currentMatchId);
}

function renderPlayerList(match) {
  const listEl = document.getElementById('player-list');
  const players = match.players || [];
  const hasCost = match.totalCost > 0;

  if (players.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <p>No players yet</p>
        <p class="text-muted">Type a name above and tap Add</p>
      </div>`;
    return;
  }

  // Sort: unpaid first (when cost set), then alphabetical
  const sorted = [...players].sort((a, b) => {
    if (hasCost && a.paid !== b.paid) return a.paid ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  listEl.innerHTML = sorted.map(p => {
    const canToggle = hasCost;
    return `
      <div class="player-item ${p.paid && hasCost ? 'paid' : ''}" ${canToggle ? `onclick="togglePaid('${escapeAttr(p.name)}', ${!p.paid})"` : ''}>
        <div class="player-checkbox ${hasCost ? '' : 'checked-in'}">${hasCost ? (p.paid ? '✓' : '') : '✓'}</div>
        <span class="player-name">${escapeHtml(p.name)}</span>
        ${hasCost
          ? `<span class="player-amount ${p.paid ? 'paid-amount' : ''}">₹${p.amountOwed}</span>`
          : `<button class="player-remove" onclick="event.stopPropagation(); handleRemovePlayer('${escapeAttr(p.name)}')" title="Remove">✕</button>`
        }
      </div>`;
  }).join('');
}

function updateSummary(match) {
  const players = match.players || [];
  const summaryBar = document.getElementById('summary-bar');
  if (!match.totalCost || players.length === 0) {
    summaryBar.style.display = 'none';
    return;
  }
  summaryBar.style.display = '';
  const paidCount = players.filter(p => p.paid).length;
  const paidAmount = players.filter(p => p.paid).reduce((s, p) => s + p.amountOwed, 0);
  const remaining = match.totalCost - paidAmount;
  document.getElementById('summary-text').innerHTML =
    `<strong>${paidCount}/${players.length}</strong> paid &nbsp;·&nbsp; ₹${paidAmount} collected &nbsp;·&nbsp; <span style="color:${remaining > 0 ? 'var(--red)' : 'var(--green)'}">₹${remaining} pending</span>`;
}

// --- Check In ---
async function handleCheckIn() {
  const input = document.getElementById('checkin-name');
  const name = input.value.trim();
  if (!name) return showToast('Enter your name', true);

  const data = await api('checkIn', { matchId: currentMatchId, playerName: name }, 'POST');
  if (data.error) return showToast(data.error, true);

  input.value = '';
  showToast(`${name} checked in!`);
  loadMatch(currentMatchId);
}

// Enter key to check in
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.id === 'checkin-name') {
    handleCheckIn();
  }
});

// --- Remove Player ---
async function handleRemovePlayer(name) {
  const data = await api('removePlayer', { matchId: currentMatchId, playerName: name }, 'POST');
  if (data.error) return showToast(data.error, true);
  showToast(`${name} removed`);
  loadMatch(currentMatchId);
}

// handleLockMatch removed — cost is now saved automatically via saveCost()

// --- Mark Paid ---
async function togglePaid(playerName, paid) {
  const data = await api('markPaid', { matchId: currentMatchId, playerName, paid }, 'POST');
  if (data.error) return showToast(data.error, true);
  loadMatch(currentMatchId);
}

// --- CricHeroes Import ---
async function handleScrape() {
  const urlInput = document.getElementById('cricheroes-url');
  const url = urlInput.value.trim();
  if (!url) return showToast('Paste a CricHeroes match URL', true);

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Fetching...';

  const data = await api('scrape', { url });

  btn.disabled = false;
  btn.textContent = 'Fetch Players';

  if (data.error) return showToast(data.error, true);

  const players = data.players || [];
  if (players.length === 0) return showToast('No players found', true);

  // Check in each player
  let added = 0;
  for (const p of players) {
    const result = await api('checkIn', { matchId: currentMatchId, playerName: p.name }, 'POST');
    if (result.success) added++;
  }

  showToast(`${added} players imported!`);
  urlInput.value = '';
  loadMatch(currentMatchId);
}

// --- Player Stats ---
async function loadStats() {
  const loading = document.getElementById('stats-loading');
  const tableWrap = document.getElementById('stats-table-wrap');
  const noStats = document.getElementById('no-stats');

  loading.style.display = '';
  tableWrap.innerHTML = '';
  noStats.style.display = 'none';

  const data = await api('players');
  loading.style.display = 'none';

  if (data.error) {
    tableWrap.innerHTML = `<div class="empty-state"><p>${data.error}</p></div>`;
    return;
  }

  const players = data.players || [];
  if (players.length === 0) {
    noStats.style.display = '';
    return;
  }

  tableWrap.innerHTML = `
    <table class="stats-table">
      <thead>
        <tr>
          <th onclick="sortStats('name')">Player</th>
          <th onclick="sortStats('matches')">#</th>
          <th onclick="sortStats('totalOwed')">Owed</th>
          <th onclick="sortStats('totalPaid')">Paid</th>
          <th onclick="sortStats('outstanding')">Due</th>
        </tr>
      </thead>
      <tbody>
        ${players.map(p => `
          <tr>
            <td>${escapeHtml(p.name)}</td>
            <td>${p.matches}</td>
            <td>₹${p.totalOwed}</td>
            <td>₹${p.totalPaid}</td>
            <td class="${p.outstanding > 0 ? 'outstanding-positive' : 'outstanding-zero'}">
              ₹${p.outstanding}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  // Store for sorting
  window._statsPlayers = players;
}

let _statsSortKey = 'matches';
let _statsSortAsc = false;

function sortStats(key) {
  if (_statsSortKey === key) {
    _statsSortAsc = !_statsSortAsc;
  } else {
    _statsSortKey = key;
    _statsSortAsc = key === 'name';
  }

  const players = window._statsPlayers || [];
  players.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (typeof va === 'string') {
      return _statsSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return _statsSortAsc ? va - vb : vb - va;
  });

  // Re-render table body
  const tbody = document.querySelector('.stats-table tbody');
  if (tbody) {
    tbody.innerHTML = players.map(p => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${p.matches}</td>
        <td>₹${p.totalOwed}</td>
        <td>₹${p.totalPaid}</td>
        <td class="${p.outstanding > 0 ? 'outstanding-positive' : 'outstanding-zero'}">
          ₹${p.outstanding}
        </td>
      </tr>
    `).join('');
  }
}

// --- Share ---
async function handleShare() {
  const url = window.location.href;
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Cricket Match Check-in',
        text: 'Check in for the cricket match!',
        url: url
      });
    } catch (e) {
      // User cancelled share
    }
  } else {
    await navigator.clipboard.writeText(url);
    showToast('Link copied to clipboard!');
  }
}

// --- Utilities ---

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  // Escape backslashes first, then quotes — prevents onclick attribute injection
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// --- Toast ---
let toastTimeout;
function showToast(msg, isError = false) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = 'toast' + (isError ? ' error' : '');

  clearTimeout(toastTimeout);
  requestAnimationFrame(() => {
    toast.classList.add('show');
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 2500);
  });
}
