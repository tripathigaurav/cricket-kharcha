// ============================================================
// CricTracker — Frontend App
// ============================================================

const API_URL = (typeof CRICKET_API_URL !== 'undefined') ? CRICKET_API_URL : '';
const WRITE_ACTIONS = new Set(['removePlayer', 'lockMatch', 'markPaid', 'deleteMatch']);
const UPI_VPA_RE = /^[\w.\-]{2,}@[a-z]{2,}$/i;
const UPI_PHONE_RE = /^\d{10}$/;

function isValidPayInput(raw) {
  const value = raw.trim();
  return UPI_VPA_RE.test(value) || UPI_PHONE_RE.test(value);
}

// --- State ---
let currentMatchId = null;
let _currentMatch = null;
let _costSaveTimer = null;
let _lastPersistedCost = null;
let _loadGeneration = 0;
let _knownPlayers = [];
let _knownPlayersPromise = null;
let _suggestionIndex = -1;
let _writeToken = null;
let _canWrite = true;
const _markPaidPending = new Set();
let _checkInPending = false;
let _matchListCache = null;
let _matchListCacheTime = 0;
const MATCH_LIST_CACHE_MS = 15000;
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function writeTokenKey(matchId) {
  return 'w_' + matchId;
}

function getWriteToken(matchId) {
  if (!matchId) return null;
  if (_writeToken && currentMatchId === matchId) return _writeToken;
  try {
    return localStorage.getItem(writeTokenKey(matchId))
      || sessionStorage.getItem(writeTokenKey(matchId))
      || null;
  } catch (e) {
    return null;
  }
}

function storeWriteToken(matchId, token) {
  if (!matchId || !token) return;
  _writeToken = token;
  try {
    localStorage.setItem(writeTokenKey(matchId), token);
    sessionStorage.setItem(writeTokenKey(matchId), token);
  } catch (e) {}
}

function buildMatchHash(matchId) {
  const id = encodeURIComponent(matchId);
  const w = getWriteToken(matchId);
  return w ? `#/match/${id}?w=${encodeURIComponent(w)}` : `#/match/${id}`;
}

function parseMatchRoute(hash) {
  const rest = (hash || '').replace(/^#\/match\//, '');
  const [idPart, query] = rest.split('?');
  const matchId = decodeURIComponent((idPart || '').split('#')[0]);
  let writeToken = null;
  if (query) writeToken = new URLSearchParams(query).get('w');
  return { matchId, writeToken };
}

// --- API Helper ---
async function api(action, params = {}, method = 'GET') {
  if (!API_URL || API_URL.includes('YOUR_APPS_SCRIPT')) {
    return { error: 'Backend not configured. Copy config.example.js to config.js and set your Apps Script URL.' };
  }
  try {
    let payload = { ...params };
    if (method === 'POST' && WRITE_ACTIONS.has(action) && payload.matchId) {
      const token = payload.writeToken || getWriteToken(payload.matchId);
      if (token) payload.writeToken = token;
    }
    let resp;
    if (method === 'GET') {
      const qs = new URLSearchParams({ action, ...payload }).toString();
      resp = await fetch(`${API_URL}?${qs}`, { redirect: 'follow' });
    } else {
      resp = await fetch(API_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action, ...payload })
      });
    }
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch (e) { return { error: 'Server returned invalid response' }; }
  } catch (err) {
    console.error('API error:', err);
    showToast('Network error. Please try again.', 'error');
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

function setPageTitle(text) {
  const el = document.getElementById('page-title-text');
  if (el) el.textContent = text;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function initSplash() {
  const splash = document.getElementById('splash');
  const app = document.getElementById('app');
  if (!splash) {
    if (app) app.classList.add('app-ready');
    return;
  }

  try {
    if (sessionStorage.getItem('splash_seen')) {
      splash.remove();
      app.classList.add('app-ready');
      return;
    }
  } catch (e) {}

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    try { sessionStorage.setItem('splash_seen', '1'); } catch (e) {}
    splash.remove();
    app.classList.add('app-ready');
    return;
  }

  const minMs = 900;
  const maxMs = 2500;
  const start = Date.now();
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    const wait = Math.max(0, minMs - (Date.now() - start));
    setTimeout(() => {
      try { sessionStorage.setItem('splash_seen', '1'); } catch (e) {}
      splash.classList.add('splash-exit');
      app.classList.add('app-ready');
      const removeSplash = () => { if (splash.parentNode) splash.remove(); };
      splash.addEventListener('transitionend', removeSplash, { once: true });
      setTimeout(removeSplash, 450);
    }, wait);
  }

  if (document.readyState === 'complete') {
    finish();
  } else {
    window.addEventListener('load', finish, { once: true });
  }
  setTimeout(finish, maxMs);
}

function handleRoute() {
  clearTimeout(_costSaveTimer);
  _loadGeneration++;

  const hash = window.location.hash || '#/';
  const views = document.querySelectorAll('.view');
  views.forEach(v => { v.style.display = 'none'; v.classList.remove('view-enter'); });

  const backBtn = document.getElementById('btn-back');
  const statsBtn = document.getElementById('btn-stats');

  backBtn.style.display = 'none';
  statsBtn.style.display = '';
  setPageTitle('CricTracker');

  hideSuggestions();

  let activeView;
  if (hash === '#/' || hash === '#' || hash === '') {
    activeView = document.getElementById('view-home');
    activeView.style.display = '';
    loadMatches();
  } else if (hash === '#/new') {
    activeView = document.getElementById('view-new');
    activeView.style.display = '';
    backBtn.style.display = '';
    setPageTitle('New Match');
    document.getElementById('match-date').value = todayISO();
    document.getElementById('pay-to').value = '';
    document.getElementById('pay-upi').value = localStorage.getItem('last_payToUPI') || '';
    const costField = document.getElementById('new-match-cost');
    if (costField) costField.value = '';
  } else if (hash.startsWith('#/match/')) {
    activeView = document.getElementById('view-match');
    activeView.style.display = '';
    backBtn.style.display = '';
    setPageTitle('Match');
    const route = parseMatchRoute(hash);
    currentMatchId = route.matchId;
    if (route.writeToken) {
      storeWriteToken(route.matchId, route.writeToken);
    } else {
      const stored = getWriteToken(route.matchId);
      if (stored) history.replaceState(null, '', buildMatchHash(route.matchId));
    }
    loadMatch(currentMatchId);
  } else if (hash === '#/stats') {
    activeView = document.getElementById('view-stats');
    activeView.style.display = '';
    backBtn.style.display = '';
    statsBtn.style.display = 'none';
    setPageTitle('Player Stats');
    loadStats();
  } else {
    activeView = document.getElementById('view-home');
    activeView.style.display = '';
    loadMatches();
  }

  if (activeView) {
    requestAnimationFrame(() => activeView.classList.add('view-enter'));
  }
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('DOMContentLoaded', () => {
  setupEventDelegation();
  setupCheckinInput();
  initSplash();
  handleRoute();
  setTimeout(() => ensureKnownPlayers(), 400);
});

// --- Event Delegation (replaces inline onclick for security) ---
function setupEventDelegation() {
  const playerList = document.getElementById('player-list');
  if (playerList) {
    playerList.addEventListener('click', (e) => {
      const item = e.target.closest('.player-item');
      if (!item) return;

      const removeBtn = e.target.closest('.player-remove');
      if (removeBtn) {
        e.stopPropagation();
        const name = removeBtn.dataset.playerName;
        if (name) handleRemovePlayer(name);
        return;
      }

      if (item.dataset.canToggle === 'true') {
        const name = item.dataset.playerName;
        const newPaid = item.dataset.paid !== 'true';
        if (name) togglePaid(item, name, newPaid);
      }
    });
  }

  const matchList = document.getElementById('match-list');
  if (matchList) {
    matchList.addEventListener('click', (e) => {
      const card = e.target.closest('.match-card');
      if (card && card.dataset.matchId) {
        navigate(buildMatchHash(card.dataset.matchId));
      }
    });
  }
}

// --- Check-in Input Setup ---
function setupCheckinInput() {
  const input = document.getElementById('checkin-name');
  if (!input) return;

  input.addEventListener('keydown', (e) => {
    const dropdown = document.getElementById('checkin-suggestions');
    const items = dropdown ? dropdown.querySelectorAll('.suggestion-item') : [];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _suggestionIndex = Math.min(_suggestionIndex + 1, items.length - 1);
      updateSuggestionHighlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _suggestionIndex = Math.max(_suggestionIndex - 1, -1);
      updateSuggestionHighlight(items);
    } else if (e.key === 'Enter') {
      if (_suggestionIndex >= 0 && items[_suggestionIndex]) {
        e.preventDefault();
        const name = items[_suggestionIndex].dataset.name;
        input.value = name;
        hideSuggestions();
        handleCheckIn();
      } else {
        handleCheckIn();
      }
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  input.addEventListener('input', async () => {
    const q = input.value.trim();
    if (!q) return hideSuggestions();
    await ensureKnownPlayers();
    showSuggestions(q);
  });

  input.addEventListener('focus', () => {
    ensureKnownPlayers().then(() => {
      const q = input.value.trim();
      if (q) showSuggestions(q);
    });
  });

  input.addEventListener('blur', () => {
    setTimeout(hideSuggestions, 200);
  });
}

function nameMatchesQuery(name, queryLower) {
  const n = name.toLowerCase();
  if (queryLower.length < 2) return n.startsWith(queryLower);
  return n.startsWith(queryLower) || n.includes(queryLower);
}

function showSuggestions(query) {
  const dropdown = document.getElementById('checkin-suggestions');
  if (!dropdown || !query || query.length < 1) {
    hideSuggestions();
    return;
  }

  const currentPlayers = (_currentMatch?.players || []).map(p => p.name.toLowerCase());
  const queryLower = query.toLowerCase();
  const matches = _knownPlayers
    .filter(p => nameMatchesQuery(p.name, queryLower) && !currentPlayers.includes(p.name.toLowerCase()))
    .sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name))
    .slice(0, 6);

  if (matches.length === 0) {
    hideSuggestions();
    return;
  }

  _suggestionIndex = -1;
  dropdown.innerHTML = matches.map(p =>
    `<div class="suggestion-item" data-name="${escapeAttr(p.name)}">` +
    `${escapeHtml(p.name)}` +
    `<span class="suggestion-games">${p.matches} game${p.matches !== 1 ? 's' : ''}</span>` +
    `</div>`
  ).join('');
  dropdown.style.display = '';

  dropdown.querySelectorAll('.suggestion-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const input = document.getElementById('checkin-name');
      input.value = item.dataset.name;
      hideSuggestions();
      handleCheckIn();
    });
  });
}

function hideSuggestions() {
  const dropdown = document.getElementById('checkin-suggestions');
  if (dropdown) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
  }
  _suggestionIndex = -1;
}

function updateSuggestionHighlight(items) {
  items.forEach((item, i) => {
    item.classList.toggle('active', i === _suggestionIndex);
  });
}

// --- Fetch Known Players for Autocomplete ---
async function ensureKnownPlayers(force = false) {
  if (_knownPlayers.length > 0 && !force) return;
  if (_knownPlayersPromise && !force) return _knownPlayersPromise;

  _knownPlayersPromise = (async () => {
    const data = await api('players');
    if (data.players && Array.isArray(data.players)) {
      _knownPlayers = mergePlayerStats(data.players);
    }
  })();

  try {
    await _knownPlayersPromise;
  } finally {
    _knownPlayersPromise = null;
  }
}

async function fetchKnownPlayers(force = false) {
  return ensureKnownPlayers(force);
}

function addKnownPlayerName(name) {
  const key = name.toLowerCase().replace(/\s*\(\d+\)$/, '').replace(/\s+/g, ' ').trim();
  const existing = _knownPlayers.find(p =>
    p.name.toLowerCase().replace(/\s*\(\d+\)$/, '').replace(/\s+/g, ' ').trim() === key
  );
  if (existing) {
    existing.matches += 1;
    return;
  }
  _knownPlayers.push({ name, matches: 1, totalOwed: 0, totalPaid: 0, outstanding: 0 });
}

// --- Match List ---
function skeletonCards(count) {
  return Array.from({ length: count }, () =>
    `<div class="skeleton-card">
      <div class="skeleton-line w60"></div>
      <div class="skeleton-line w40 h8"></div>
      <div class="skeleton-line w80 h20"></div>
    </div>`
  ).join('');
}

function invalidateMatchListCache() {
  _matchListCache = null;
  _matchListCacheTime = 0;
}

async function loadMatches(force = false) {
  const gen = _loadGeneration;
  const listEl = document.getElementById('match-list');
  const emptyEl = document.getElementById('no-matches');

  const cacheFresh = _matchListCache && (Date.now() - _matchListCacheTime < MATCH_LIST_CACHE_MS);
  if (!force && cacheFresh) {
    renderMatchList(_matchListCache, listEl, emptyEl);
    return;
  }

  listEl.innerHTML = skeletonCards(3);
  emptyEl.style.display = 'none';

  const data = await api('matches');
  if (_loadGeneration !== gen) return;

  if (!data.error && data.matches) {
    _matchListCache = data.matches;
    _matchListCacheTime = Date.now();
  }

  if (data.error) {
    listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(data.error)}</p></div>`;
    return;
  }

  renderMatchList(data.matches || [], listEl, emptyEl);
}

function renderMatchList(matches, listEl, emptyEl) {
  if (matches.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  // Group by date
  const groups = {};
  matches.forEach(m => {
    const dateKey = m.date || 'Unknown';
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(m);
  });

  let html = '';
  let cardIndex = 0;
  Object.entries(groups).forEach(([dateKey, group]) => {
    html += `<div class="date-group">`;
    html += `<div class="date-group-header">📅 ${formatDate(dateKey)}</div>`;
    group.forEach(m => {
      const hasCost = m.totalCost > 0;
      const pct = m.playerCount > 0 ? Math.round((m.paidCount / m.playerCount) * 100) : 0;
      const allPaid = hasCost && m.paidCount === m.playerCount && m.playerCount > 0;
      const isPartial = hasCost && m.paidCount > 0 && !allPaid;
      const isCheckin = !hasCost && m.playerCount > 0;
      const isEmpty = m.playerCount === 0;

      let stateClass = '';
      if (allPaid) stateClass = 'card-all-paid';
      else if (isPartial) stateClass = 'card-partial';
      else if (isCheckin) stateClass = 'card-checkin';
      else if (isEmpty) stateClass = 'card-empty';

      const circumference = 2 * Math.PI * 13;
      const dashoffset = circumference - (pct / 100) * circumference;

      const perPlayer = hasCost && m.playerCount > 0 ? Math.ceil(m.totalCost / m.playerCount) : 0;
      const statusBadge = allPaid
        ? `<span class="match-card-settled">All settled</span>`
        : hasCost
          ? `<span class="match-card-status status-locked">${m.paidCount > 0 ? 'Collecting' : 'Awaiting payment'}</span>`
          : isCheckin
            ? `<span class="match-card-status status-checkin">${m.playerCount} at crease</span>`
            : `<span class="match-card-status status-checkin">Awaiting players</span>`;

      const cardMeta = hasCost
        ? `${escapeHtml(m.payTo || '—')} · ₹${perPlayer}/player · ${m.paidCount}/${m.playerCount} paid`
        : `${escapeHtml(m.payTo || '—')} · ${m.playerCount} player${m.playerCount !== 1 ? 's' : ''}`;

      html += `
        <div class="match-card ${stateClass}" data-match-id="${escapeAttr(m.matchId)}" style="animation-delay:${cardIndex * 50}ms">
          <div class="match-card-emoji" aria-hidden="true">${allPaid ? '🏆' : hasCost ? (m.paidCount > 0 ? '💸' : '⏳') : isCheckin ? '🏏' : '🆕'}</div>
          <div class="match-card-body">
            <div class="match-card-top">
              <span class="match-card-cost">${hasCost ? '<span class="match-card-cost-prefix">₹</span>' + m.totalCost : '<span class="text-muted" style="font-size:14px">No cost yet</span>'}</span>
              ${statusBadge}
            </div>
            <div class="match-card-submeta">${cardMeta}</div>
            ${hasCost && !allPaid && m.playerCount > 0 ? `
            <div class="match-card-bottom">
              <svg class="progress-ring" viewBox="0 0 32 32">
                <circle class="progress-ring-bg" cx="16" cy="16" r="13"/>
                <circle class="progress-ring-fill" cx="16" cy="16" r="13" stroke-dasharray="${circumference}" stroke-dashoffset="${dashoffset}"/>
              </svg>
              <span class="match-card-progress">
                <span class="progress-bar"><span class="progress-fill" style="width:${pct}%"></span></span>
                <span class="progress-label">${m.paidAmount > 0 ? '₹' + m.paidAmount + ' collected' : 'No payments yet'}</span>
              </span>
            </div>` : hasCost && allPaid ? `
            <div class="match-card-bottom">
              <span class="match-card-meta" style="color:var(--paid)">All settled · ₹${m.totalCost}</span>
            </div>` : !hasCost ? `
            <div class="match-card-bottom">
              <span class="match-card-meta">Tap to check in players</span>
            </div>` : ''}
          </div>
        </div>`;
      cardIndex++;
    });
    html += `</div>`;
  });

  listEl.innerHTML = html;
}

// --- Create Match ---
async function handleCreateMatch(btn) {
  const date = document.getElementById('match-date').value;
  const payTo = document.getElementById('pay-to').value.trim();
  const payToRaw = document.getElementById('pay-upi').value.trim();
  const upfrontCost = Number(document.getElementById('new-match-cost')?.value) || 0;
  const alsoPlaying = document.getElementById('payto-plays')?.checked;

  if (!date) return showToast('Please select a date', 'error');
  if (!payTo) return showToast('Please enter who to pay', 'error');
  if (!payToRaw) return showToast('Please enter a UPI ID or phone number', 'error');
  if (!isValidPayInput(payToRaw)) {
    return showToast('Enter a 10-digit phone or UPI ID (e.g. 9876543210 or name@ybl)', 'error');
  }
  const payToUPI = payToRaw.trim();

  btn.disabled = true;
  btn.textContent = 'Creating...';

  const data = await api('createMatch', {
    date, payTo, payToUPI,
    checkInCollector: !!alsoPlaying
  }, 'POST');

  btn.disabled = false;
  btn.textContent = 'Create Match';

  if (data.error) return showToast(data.error, 'error');

  // Save for next time
  try {
    localStorage.setItem('last_payTo', payTo);
    localStorage.setItem('last_payToUPI', payToUPI);
  } catch (e) {}

  if (upfrontCost > 0 && data.matchId) {
    try { localStorage.setItem('pending_cost_' + data.matchId, String(upfrontCost)); } catch (e) {}
  }

  if (data.writeToken) storeWriteToken(data.matchId, data.writeToken);
  invalidateMatchListCache();
  showToast('Match created!');
  const adminQuery = data.writeToken ? `?w=${encodeURIComponent(data.writeToken)}` : '';
  navigate(`#/match/${encodeURIComponent(data.matchId)}${adminQuery}`);
}

// --- Load Match Detail ---
function skeletonPlayers(count) {
  return Array.from({ length: count }, () =>
    `<div class="skeleton-player">
      <div class="skeleton-circle"></div>
      <div class="skeleton-line w60" style="margin-bottom:0;flex:1"></div>
    </div>`
  ).join('');
}

async function loadMatch(matchId, options = {}) {
  const silent = options.silent === true;
  const gen = _loadGeneration;
  const loading = document.getElementById('match-loading');
  const body = document.getElementById('match-body');

  if (!silent) {
    loading.style.display = '';
    body.style.display = 'none';
  }

  const data = await api('match', { id: matchId });

  if (_loadGeneration !== gen) return;

  if (data.error) {
    if (!silent) {
      loading.style.display = '';
      loading.textContent = data.error;
    }
    return;
  }

  if (!silent) {
    loading.style.display = 'none';
    body.style.display = '';
  }

  let match = data.match;
  if (isSplitStale(match)) {
    match = await resyncSplitIfStale(match, matchId);
  }

  applyMatchData(match, matchId);
}

function applyMatchData(match, matchId) {
  _currentMatch = match;

  _canWrite = !match.requiresWriteToken || !!getWriteToken(matchId);
  applyReadOnlyUI();

  setPageTitle(formatDate(match.date));

  const payBar = document.getElementById('payment-info-bar');
  const perPlayerDisplay = expectedPerPlayer(match) || match.perPlayerCost;
  if (match.totalCost > 0 && match.payTo) {
    payBar.style.display = '';
    const playerCount = match.players.length;
    const labelEl = document.querySelector('.pay-amount-label');
    if (labelEl) {
      labelEl.textContent = playerCount > 0
        ? `Per player · ₹${match.totalCost} ÷ ${playerCount}`
        : 'Per player';
    }
    document.getElementById('pay-amount-display').innerHTML =
      `<span class="pay-amount-prefix">₹</span>${perPlayerDisplay}`;

    const payToInfo = document.getElementById('pay-to-info');
    if (payToInfo) {
      payToInfo.innerHTML = `Pay to <strong>${escapeHtml(match.payTo)}</strong>${match.payToUPI ? ' (' + escapeHtml(match.payToUPI) + ')' : ''}`;
    }

    const copyBtn = document.getElementById('btn-copy-upi');
    if (copyBtn) copyBtn.style.display = match.payToUPI ? '' : 'none';

    const upiLink = document.getElementById('upi-link');
    let showUpiLink = false;
    if (upiLink) {
      if (match.payToUPI && IS_MOBILE) {
        const upiTn = encodeURIComponent('Cricket ' + formatDate(match.date));
        upiLink.href = `upi://pay?pa=${encodeURIComponent(match.payToUPI)}&am=${perPlayerDisplay}&cu=INR&tn=${upiTn}`;
        upiLink.style.display = '';
        showUpiLink = true;
      } else {
        upiLink.style.display = 'none';
      }
    }
    payBar.classList.toggle('compact', !match.payToUPI && !showUpiLink);
  } else {
    payBar.style.display = 'none';
    const labelEl = document.querySelector('.pay-amount-label');
    if (labelEl) labelEl.textContent = 'Per Player';
  }

  const costInput = document.getElementById('total-cost');
  if (match.totalCost > 0) {
    costInput.value = match.totalCost;
    _lastPersistedCost = match.totalCost;
  } else {
    _lastPersistedCost = null;
    try {
      const pending = localStorage.getItem('pending_cost_' + matchId);
      if (pending) {
        costInput.value = pending;
        if (match.players.length > 0) {
          setTimeout(() => {
            const pendingCheck = localStorage.getItem('pending_cost_' + matchId);
            if (pendingCheck) {
              localStorage.removeItem('pending_cost_' + matchId);
              saveCost();
            }
          }, 100);
        }
      }
    } catch (e) {}
  }
  updateSplitPreview();
  updateCostSectionUI(match);

  const badge = document.getElementById('player-count-badge');
  if (badge) {
    badge.textContent = match.players.length > 0 ? match.players.length : '';
    badge.style.display = match.players.length > 0 ? '' : 'none';
  }

  renderPlayerList(match);
  updateSummary(match);

  if (_canWrite) {
    costInput.oninput = () => {
      updateSplitPreview();
      clearTimeout(_costSaveTimer);
      _costSaveTimer = setTimeout(() => saveCost(), 1500);
    };
  } else {
    costInput.oninput = null;
  }
}

function updateCostSectionUI(match) {
  const section = document.getElementById('split-cost-section');
  const editBtn = document.getElementById('btn-edit-cost');
  if (!section) return;

  if (match.totalCost > 0) {
    section.style.display = section.dataset.editing === 'true' ? '' : 'none';
    if (editBtn) editBtn.style.display = (_canWrite && section.style.display === 'none') ? '' : 'none';
  } else {
    section.style.display = '';
    section.dataset.editing = '';
    if (editBtn) editBtn.style.display = 'none';
  }
}

function toggleCostEdit() {
  const section = document.getElementById('split-cost-section');
  const editBtn = document.getElementById('btn-edit-cost');
  if (!section) return;
  section.dataset.editing = 'true';
  section.style.display = '';
  if (editBtn) editBtn.style.display = 'none';
  const costInput = document.getElementById('total-cost');
  if (costInput) costInput.focus();
}

function applyReadOnlyUI() {
  const banner = document.getElementById('readonly-banner');
  if (banner) banner.style.display = _canWrite ? 'none' : '';

  const costInput = document.getElementById('total-cost');
  if (costInput) {
    costInput.readOnly = !_canWrite;
    costInput.classList.toggle('input-readonly', !_canWrite);
  }

  const checkinRow = document.querySelector('.checkin-form');
  if (checkinRow) checkinRow.style.display = '';

  const importBlock = document.querySelector('.cricheroes-import');
  if (importBlock) importBlock.style.display = _canWrite ? '' : 'none';

  const actionsRow = document.querySelector('.match-actions-row');
  if (actionsRow) {
    const deleteBtn = actionsRow.querySelector('.btn-delete-match');
    if (deleteBtn) deleteBtn.style.display = _canWrite ? '' : 'none';
  }

  if (_currentMatch) updateCostSectionUI(_currentMatch);
}

function handleCopyUPI() {
  if (!_currentMatch?.payToUPI) return;
  const per = expectedPerPlayer(_currentMatch) || _currentMatch.perPlayerCost;
  const text = `${_currentMatch.payToUPI}\nPay ₹${per} for Cricket ${formatDate(_currentMatch.date)}`;
  try {
    navigator.clipboard.writeText(text);
    showToast('UPI ID copied!');
  } catch (e) {
    showToast('Could not copy', 'error');
  }
}

function expectedPerPlayer(match) {
  if (!match?.totalCost || !match.players?.length) return 0;
  return Math.ceil(match.totalCost / match.players.length);
}

function isSplitStale(match) {
  if (!match?.totalCost || !match.players?.length) return false;
  const expected = expectedPerPlayer(match);
  if (match.perPlayerCost !== expected) return true;
  return match.players.some(p => p.amountOwed !== expected);
}

function applyExpectedSplit(match) {
  const per = expectedPerPlayer(match);
  if (!per) return match;
  match.perPlayerCost = per;
  match.players.forEach(p => { p.amountOwed = per; });
  return match;
}

function applyServerSplit(match, data) {
  if (!data?.perPlayerCost) return match;
  if (data.totalCost) match.totalCost = data.totalCost;
  match.perPlayerCost = data.perPlayerCost;
  match.players.forEach(p => { p.amountOwed = data.perPlayerCost; });
  return match;
}

async function resyncSplitIfStale(match, matchId) {
  if (!isSplitStale(match)) return match;

  const canWrite = !match.requiresWriteToken || !!getWriteToken(matchId);
  const localFix = () => applyExpectedSplit({
    ...match,
    players: match.players.map(p => ({ ...p }))
  });

  if (!canWrite) return localFix();

  const lock = await api('lockMatch', { matchId, totalCost: match.totalCost }, 'POST');
  if (!lock.success) return localFix();

  return applyServerSplit({
    ...match,
    players: match.players.map(p => ({ ...p }))
  }, lock);
}

function updateSplitPreview() {
  const preview = document.getElementById('split-preview');
  if (!preview) return;

  // Pay banner already shows per-player when cost is saved
  if (_currentMatch?.totalCost > 0) {
    preview.textContent = '';
    preview.style.display = 'none';
    return;
  }

  const costInput = document.getElementById('total-cost');
  const cost = Number(costInput.value);
  const count = _currentMatch ? _currentMatch.players.length : 0;

  if (cost > 0 && count > 0) {
    preview.innerHTML = `Each batter owes <strong>₹${Math.ceil(cost / count)}</strong> (₹${cost} ÷ ${count})`;
    preview.style.display = '';
  } else if (cost > 0) {
    preview.textContent = 'Add players to see the split';
    preview.style.display = '';
  } else {
    preview.textContent = '';
    preview.style.display = 'none';
  }
}

async function saveCost() {
  if (!_canWrite) return;
  const cost = Number(document.getElementById('total-cost').value);
  if (!cost || cost <= 0 || !_currentMatch) return;
  if (cost === _lastPersistedCost) return;
  const data = await api('lockMatch', { matchId: currentMatchId, totalCost: cost }, 'POST');
  if (data.error) return showToast(data.error, 'error');
  _lastPersistedCost = cost;
  const section = document.getElementById('split-cost-section');
  if (section) section.dataset.editing = '';
  if (_currentMatch) {
    _currentMatch.totalCost = cost;
    applyServerSplit(_currentMatch, data);
    applyMatchData(_currentMatch, currentMatchId);
  }
  invalidateMatchListCache();
}

function renderPlayerList(match) {
  const listEl = document.getElementById('player-list');
  const players = match.players || [];
  const hasCost = match.totalCost > 0;

  if (players.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state" style="padding:32px 24px">
        <div class="empty-icon ball"></div>
        <h3>No one at the crease</h3>
        <p>Type a name above and tap Add</p>
      </div>`;
    return;
  }

  const sorted = [...players].sort((a, b) => {
    if (hasCost && a.paid !== b.paid) return a.paid ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const perPlayer = expectedPerPlayer(match);

  listEl.innerHTML = sorted.map((p, i) => {
    const canToggle = hasCost && _canWrite;
    const showRemove = !hasCost && _canWrite;
    const owed = hasCost && perPlayer ? perPlayer : p.amountOwed;
    return `
      <div class="player-item ${p.paid && hasCost ? 'paid' : ''}"
           data-player-name="${escapeAttr(p.name)}"
           data-can-toggle="${canToggle}"
           data-paid="${p.paid && hasCost}"
           style="animation-delay:${i * 50}ms">
        <div class="player-checkbox ${hasCost ? '' : 'checked-in'}">${hasCost ? (p.paid ? '✓' : '') : '✓'}</div>
        <span class="player-name">${escapeHtml(p.name)}</span>
        ${hasCost
          ? `<span class="player-amount ${p.paid ? 'paid-amount' : ''}">₹${owed}</span>`
          : showRemove
            ? `<button class="player-remove" data-player-name="${escapeAttr(p.name)}" title="Remove">✕</button>`
            : ''
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
  const perPlayer = expectedPerPlayer(match);
  const paidCount = players.filter(p => p.paid).length;
  if (paidCount === players.length) {
    summaryBar.style.display = 'none';
    return;
  }
  summaryBar.style.display = '';
  const paidAmount = paidCount * (perPlayer || 0);
  const remaining = Math.max(0, match.totalCost - paidAmount);
  document.getElementById('summary-text').innerHTML =
    `<strong>${paidCount}/${players.length}</strong> paid · <span style="color:var(--warn)">₹${remaining} left</span>`;
}

// --- Check In ---
async function handleCheckIn() {
  const input = document.getElementById('checkin-name');
  const name = input.value.trim();
  if (!name) return showToast('Enter a name', 'error');
  if (_checkInPending) return;

  hideSuggestions();
  _checkInPending = true;
  input.disabled = true;

  const data = await api('checkIn', { matchId: currentMatchId, playerName: name }, 'POST');

  input.disabled = false;
  _checkInPending = false;

  if (data.error) return showToast(data.error, 'error');

  input.value = '';
  if (_currentMatch) {
    const key = name.toLowerCase();
    if (!_currentMatch.players.some(p => p.name.toLowerCase() === key)) {
      _currentMatch.players.push({
        name,
        playerId: '',
        amountOwed: data.perPlayerCost || 0,
        paid: false,
        paidTimestamp: ''
      });
    }
    if (data.perPlayerCost) applyServerSplit(_currentMatch, data);
    else applyExpectedSplit(_currentMatch);
    applyMatchData(_currentMatch, currentMatchId);
    addKnownPlayerName(name);
  }
  showToast(`${name} is at the crease!`);
  invalidateMatchListCache();
}

// --- Remove Player ---
async function handleRemovePlayer(name) {
  if (!_canWrite) return showToast('View-only link — cannot remove players', 'error');
  const data = await api('removePlayer', { matchId: currentMatchId, playerName: name }, 'POST');
  if (data.error) return showToast(data.error, 'error');
  if (_currentMatch) {
    _currentMatch.players = _currentMatch.players.filter(
      p => p.name.toLowerCase() !== name.toLowerCase()
    );
    if (data.perPlayerCost) applyServerSplit(_currentMatch, data);
    else applyExpectedSplit(_currentMatch);
    applyMatchData(_currentMatch, currentMatchId);
  }
  showToast(`${name} removed`);
  invalidateMatchListCache();
}

// --- Delete Match ---
async function handleDeleteMatch() {
  if (!_canWrite) return showToast('View-only link — cannot delete match', 'error');
  if (!confirm('Delete this match and all player data?\nThis cannot be undone.')) return;

  const token = getWriteToken(currentMatchId);
  if (_currentMatch?.requiresWriteToken && !token) {
    return showToast('Admin link required — open the match you created (with ?w= in URL)', 'error');
  }

  const data = await api('deleteMatch', { matchId: currentMatchId, writeToken: token }, 'POST');
  if (data.error) {
    const msg = /write token/i.test(data.error)
      ? 'Admin token missing or expired. Use the link from when you created this match.'
      : data.error;
    return showToast(msg, 'error');
  }

  try {
    localStorage.removeItem(writeTokenKey(currentMatchId));
    sessionStorage.removeItem(writeTokenKey(currentMatchId));
  } catch (e) {}

  invalidateMatchListCache();
  showToast('Match deleted');
  location.hash = '#/';
}

// --- Mark Paid ---
async function togglePaid(el, playerName, paid) {
  if (!_canWrite) return showToast('View-only link — cannot mark payments', 'error');
  if (_markPaidPending.has(playerName)) return;
  _markPaidPending.add(playerName);
  el.style.pointerEvents = 'none';
  el.style.opacity = '0.5';
  const data = await api('markPaid', { matchId: currentMatchId, playerName, paid }, 'POST');
  _markPaidPending.delete(playerName);
  el.style.pointerEvents = '';
  el.style.opacity = '';
  if (data.error) return showToast(data.error, 'error');

  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 400);

  if (_currentMatch) {
    const player = _currentMatch.players.find(
      p => p.name.toLowerCase() === playerName.toLowerCase()
    );
    if (player) {
      player.paid = paid;
      player.paidTimestamp = paid ? new Date().toISOString() : '';
      if (data.amountOwed) player.amountOwed = data.amountOwed;
    }
    renderPlayerList(_currentMatch);
    updateSummary(_currentMatch);
    invalidateMatchListCache();
  }

  // Check if all paid -> confetti!
  if (_currentMatch && _currentMatch.totalCost > 0) {
    const allPaid = _currentMatch.players.length > 0 &&
      _currentMatch.players.every(p => p.paid);
    if (allPaid && paid) {
      showToast('All out! Every player has paid!');
      fireConfetti();
    }
  }
}

// --- CricHeroes Import ---
async function handleScrape(btn) {
  if (!_canWrite) return showToast('View-only link — cannot import players', 'error');
  const urlInput = document.getElementById('cricheroes-url');
  const url = urlInput.value.trim();
  if (!url) return showToast('Paste a CricHeroes match URL', 'error');

  btn.disabled = true;
  btn.textContent = 'Fetching...';

  const data = await api('scrape', { url });

  btn.disabled = false;
  btn.textContent = 'Fetch';

  if (data.error) return showToast(data.error, 'error');
  if (data.note) return showToast(data.note, 'error');

  const players = data.players || [];
  if (players.length === 0) return showToast('No players found', 'error');

  const currentPlayers = (_currentMatch?.players || []).map(p => p.name.toLowerCase());
  const toAdd = [];
  const dupes = [];
  let added = 0, skipped = 0, renamed = 0;

  for (const p of players) {
    if (currentPlayers.includes(p.name.toLowerCase())) dupes.push(p);
    else toAdd.push(p.name);
  }

  if (toAdd.length > 0) {
    const batch = await api('checkInBatch', { matchId: currentMatchId, playerNames: toAdd }, 'POST');
    if (batch.error) return showToast(batch.error, 'error');
    added = batch.added || 0;
    skipped += batch.skipped || 0;
    if (_currentMatch && added > 0) {
      toAdd.forEach(name => {
        if (!_currentMatch.players.some(pl => pl.name.toLowerCase() === name.toLowerCase())) {
          _currentMatch.players.push({
            name,
            playerId: '',
            amountOwed: batch.perPlayerCost || 0,
            paid: false,
            paidTimestamp: ''
          });
          addKnownPlayerName(name);
        }
      });
      if (batch.perPlayerCost) applyServerSplit(_currentMatch, batch);
      else applyExpectedSplit(_currentMatch);
      applyMatchData(_currentMatch, currentMatchId);
    }
  }

  for (const p of dupes) {
    const resolution = await showDuplicateDialog(p.name);
    if (resolution === null) {
      skipped++;
      continue;
    }
    const result = await api('checkIn', { matchId: currentMatchId, playerName: resolution }, 'POST');
    if (result.success) {
      renamed++;
      if (_currentMatch) {
        _currentMatch.players.push({
          name: resolution,
          playerId: '',
          amountOwed: result.perPlayerCost || 0,
          paid: false,
          paidTimestamp: ''
        });
        if (result.perPlayerCost) applyServerSplit(_currentMatch, result);
        applyMatchData(_currentMatch, currentMatchId);
        addKnownPlayerName(resolution);
      }
    }
  }

  const parts = [];
  if (added) parts.push(`${added} added`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (renamed) parts.push(`${renamed} renamed`);
  showToast(parts.join(', ') || 'Import complete');
  urlInput.value = '';
  invalidateMatchListCache();
}

function showDuplicateDialog(name) {
  return new Promise((resolve) => {
    const modal = document.getElementById('dup-modal');
    const msg = document.getElementById('dup-modal-msg');
    const nameInput = document.getElementById('dup-modal-name');
    const skipBtn = document.getElementById('dup-btn-skip');
    const renameBtn = document.getElementById('dup-btn-rename');

    msg.textContent = `"${name}" is already checked in. Skip or add with a different name?`;
    nameInput.value = name + ' (2)';
    nameInput.style.display = '';
    modal.style.display = '';

    function cleanup() {
      modal.style.display = 'none';
      skipBtn.removeEventListener('click', onSkip);
      renameBtn.removeEventListener('click', onRename);
    }
    function onSkip() { cleanup(); resolve(null); }
    function onRename() {
      const newName = nameInput.value.trim();
      cleanup();
      resolve(newName || null);
    }

    skipBtn.addEventListener('click', onSkip);
    renameBtn.addEventListener('click', onRename);
  });
}

// --- Player Stats ---
async function loadStats() {
  const gen = _loadGeneration;
  const loading = document.getElementById('stats-loading');
  const tableWrap = document.getElementById('stats-table-wrap');
  const noStats = document.getElementById('no-stats');

  loading.style.display = '';
  tableWrap.innerHTML = '';
  noStats.style.display = 'none';

  const data = await api('players');
  if (_loadGeneration !== gen) return;
  loading.style.display = 'none';

  if (data.error) {
    tableWrap.innerHTML = `<div class="empty-state"><p>${escapeHtml(data.error)}</p></div>`;
    return;
  }

  let players = mergePlayerStats(data.players || []);
  if (players.length === 0) {
    noStats.style.display = '';
    return;
  }

  tableWrap.innerHTML = `
    <div class="stats-sort-bar">
      <span class="stats-sort-label">Sort:</span>
      <button class="stats-sort-btn active" id="ssb-matches" onclick="sortStats('matches')">Games</button>
      <button class="stats-sort-btn" id="ssb-outstanding" onclick="sortStats('outstanding')">Due ↑</button>
      <button class="stats-sort-btn" id="ssb-totalOwed" onclick="sortStats('totalOwed')">Owed</button>
      <button class="stats-sort-btn" id="ssb-name" onclick="sortStats('name')">A–Z</button>
    </div>
    <div class="stats-cards" id="stats-cards-body">
      ${players.map((p, i) => renderStatCard(p, i)).join('')}
    </div>`;

  window._statsPlayers = players;
}

function mergePlayerStats(players) {
  const map = {};
  players.forEach(p => {
    const key = p.name.toLowerCase().replace(/\s*\(\d+\)$/, '').replace(/\s+/g, ' ').trim();
    if (!map[key]) {
      map[key] = { ...p };
      return;
    }
    map[key].matches += p.matches;
    map[key].totalOwed += p.totalOwed;
    map[key].totalPaid += p.totalPaid;
    map[key].outstanding += p.outstanding;
  });
  return Object.values(map);
}

function renderStatCard(p, index = 0) {
  const dueClass = p.outstanding > 0 ? 'due-positive' : 'due-zero';
  return `
    <div class="stat-card" style="animation-delay:${index * 40}ms">
      <div class="stat-card-top">
        <span class="stat-name">${escapeHtml(p.name)}</span>
        <span class="stat-games">${p.matches} game${p.matches !== 1 ? 's' : ''}</span>
      </div>
      <div class="stat-card-nums">
        <div class="stat-num">
          <span class="stat-num-label">Owed</span>
          <span class="stat-num-val">₹${p.totalOwed}</span>
        </div>
        <div class="stat-num">
          <span class="stat-num-label">Paid</span>
          <span class="stat-num-val paid-val">₹${p.totalPaid}</span>
        </div>
        <div class="stat-num">
          <span class="stat-num-label">Due</span>
          <span class="stat-num-val ${dueClass}">₹${p.outstanding}</span>
        </div>
      </div>
    </div>`;
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

  document.querySelectorAll('.stats-sort-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('ssb-' + key);
  if (btn) btn.classList.add('active');

  const players = window._statsPlayers || [];
  players.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (typeof va === 'string') {
      return _statsSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return _statsSortAsc ? va - vb : vb - va;
  });

  const body = document.getElementById('stats-cards-body');
  if (body) body.innerHTML = players.map((p, i) => renderStatCard(p, i)).join('');
}

// --- Share (WhatsApp-friendly) ---
async function handleShare() {
  if (!_currentMatch) return;
  const match = _currentMatch;
  const players = match.players || [];
  const hasCost = match.totalCost > 0;
  const dateStr = formatDate(match.date);
  const base = window.location.origin + window.location.pathname;
  const url = `${base}#/match/${encodeURIComponent(match.matchId)}`;
  const shareTitle = `🏏 Cricket Match — ${dateStr}`;

  let body = '';

  if (hasCost) {
    const per = expectedPerPlayer(match) || match.perPlayerCost;
    body += `💰 ₹${per} per player (₹${match.totalCost} total)\n`;
    if (match.payTo) {
      body += `📤 Pay to: ${match.payTo}`;
      if (match.payToUPI) body += ` (${match.payToUPI})`;
      body += `\n`;
    }
    body += `\n`;

    const paid = players.filter(p => p.paid);
    const unpaid = players.filter(p => !p.paid);

    if (paid.length > 0) {
      body += `✅ Paid (${paid.length}):\n`;
      paid.forEach(p => body += `  • ${p.name}\n`);
      body += `\n`;
    }
    if (unpaid.length > 0) {
      body += `⏳ Pending (${unpaid.length}):\n`;
      unpaid.forEach(p => body += `  • ${p.name} — ₹${per}\n`);
      body += `\n`;
    }

    body += `Mark your payment here:\n${url}`;
  } else {
    body += `👥 ${players.length} player${players.length !== 1 ? 's' : ''} checked in\n`;
    body += `💰 Cost not set yet\n\n`;
    body += `Check in here:\n${url}`;
  }

  const msg = `${shareTitle}\n\n${body}`;

  if (navigator.share) {
    try {
      // title + text both had the heading — apps concatenated them. Body only in text.
      await navigator.share({ title: shareTitle, text: body });
      return;
    } catch (e) {
      // User cancelled or share failed, fall through to clipboard
    }
  }

  try {
    await navigator.clipboard.writeText(msg);
    showToast('Copied to clipboard! Paste in your group');
  } catch (e) {
    showToast('Could not copy to clipboard', 'error');
  }
}

// --- Confetti ---
function fireConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#34E27A', '#FFB020', '#FF5C5C', '#4DA3FF', '#F5F7FA'];
  const pieces = Array.from({ length: 80 }, () => ({
    x: canvas.width / 2 + (Math.random() - 0.5) * 200,
    y: canvas.height / 2,
    vx: (Math.random() - 0.5) * 16,
    vy: Math.random() * -18 - 4,
    size: Math.random() * 8 + 4,
    color: colors[Math.floor(Math.random() * colors.length)],
    rotation: Math.random() * 360,
    rotSpeed: (Math.random() - 0.5) * 12,
    gravity: 0.4 + Math.random() * 0.2
  }));

  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    pieces.forEach(p => {
      p.x += p.vx;
      p.vy += p.gravity;
      p.y += p.vy;
      p.rotation += p.rotSpeed;
      p.vx *= 0.99;
      if (p.y < canvas.height + 50) alive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI / 180);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - frame / 100);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });
    frame++;
    if (alive && frame < 120) requestAnimationFrame(animate);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  animate();
}

// --- Utilities ---
function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00');
    if (isNaN(d.getTime())) return dateStr || 'Unknown date';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr || 'Unknown date';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Toast ---
let toastTimeout;
function showToast(msg, type = '') {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }

  let icon = '';
  if (type === 'error') icon = '<span class="toast-icon">⚠</span>';
  else if (msg.includes('!')) icon = '<span class="toast-icon">✓</span>';

  toast.innerHTML = icon + escapeHtml(msg);
  toast.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');

  clearTimeout(toastTimeout);
  requestAnimationFrame(() => {
    toast.classList.add('show');
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 2500);
  });
}
