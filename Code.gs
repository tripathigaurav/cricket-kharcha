// ============================================================
// CricTracker — Google Apps Script Backend
// ============================================================
// Deploy as Web App: Execute as "Me", Access "Anyone"
//
// SETUP:
// 1. Create a Google Sheet
// 2. Add 3 tabs: "Matches", "Payments", "Players"
// 3. Open Extensions > Apps Script, paste this code
// 4. In the Apps Script editor ONLY: set EDITOR_SHEET_ID below (leave empty in git — auto-used on first request)
// 5. Set project timezone: File > Project properties > Asia/Kolkata
// 6. Deploy > New Deployment > Web App > Anyone
// 7. Copy the deployment URL into config.js
// ============================================================

const MAX_NAME_LEN = 100;
const MAX_FIELD_LEN = 200;
const WRITE_TOKEN_LEN = 32;

// Set your Sheet ID here in the Apps Script editor ONLY — leave '' in the public git repo.
// Example: 'YOUR_SHEET_ID_FROM_THE_SHEET_URL'
const EDITOR_SHEET_ID = '';

// Optional global admin bypass — set in editor ONLY (e.g. 'admin_009').
// App URL: .../#/admin_009  or  .../#/match/ID?a=admin_009
// Leave '' in git. Also storable via Script Properties key ADMIN_BYPASS (configureAdminBypass()).
const EDITOR_ADMIN_BYPASS = '';

function isValidSheetId(id) {
  if (!id || typeof id !== 'string') return false;
  var s = id.trim();
  if (!s || s === 'undefined' || s === 'null' || s === 'PASTE_YOUR_SHEET_ID' || s === 'YOUR_SHEET_ID') return false;
  // Google Sheet IDs are alphanumeric + hyphens/underscores, typically 40+ chars
  return /^[a-zA-Z0-9_-]{20,}$/.test(s);
}

function getSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (isValidSheetId(id)) return SpreadsheetApp.openById(id.trim());
  if (id) props.deleteProperty('SHEET_ID'); // clear bad value e.g. literal "undefined"

  // Container-bound script: opened via Extensions > Apps Script on the sheet
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    id = active.getId();
    props.setProperty('SHEET_ID', id);
    return active;
  }

  // Editor-only constant — set EDITOR_SHEET_ID once when you paste Code.gs (no separate run needed)
  if (isValidSheetId(EDITOR_SHEET_ID)) {
    id = EDITOR_SHEET_ID.trim();
    props.setProperty('SHEET_ID', id);
    return SpreadsheetApp.openById(id);
  }

  throw new Error(
    'SHEET_ID not set. Set EDITOR_SHEET_ID at the top of Code.gs in the Apps Script editor, ' +
    'or open this project from the sheet via Extensions > Apps Script.'
  );
}

function getSheetId() {
  return getSpreadsheet().getId();
}

/** Run once from the editor — stores Sheet ID in Script Properties (not in git). */
function setSheetId(id) {
  if (!isValidSheetId(id)) {
    throw new Error('Invalid Sheet ID. Copy it from your sheet URL: .../d/YOUR_ID/edit');
  }
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', String(id).trim());
}

/** Optional: copy EDITOR_SHEET_ID into Script Properties without waiting for a web request. */
function configureSheetId() {
  if (!isValidSheetId(EDITOR_SHEET_ID)) {
    throw new Error('Set EDITOR_SHEET_ID at the top of Code.gs in the Apps Script editor first.');
  }
  setSheetId(EDITOR_SHEET_ID);
}

function getAdminBypassToken() {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('ADMIN_BYPASS');
  if (stored && stored.toString().trim()) return stored.toString().trim();
  if (typeof EDITOR_ADMIN_BYPASS === 'string' && EDITOR_ADMIN_BYPASS.trim()) {
    return EDITOR_ADMIN_BYPASS.trim();
  }
  return '';
}

function validateAdmin(token) {
  if (!token) return { valid: false };
  var bypass = getAdminBypassToken();
  if (!bypass) return { valid: false };
  return { valid: token.toString().trim() === bypass };
}

/** Run once from editor — stores EDITOR_ADMIN_BYPASS in Script Properties. */
function configureAdminBypass() {
  if (!EDITOR_ADMIN_BYPASS || !EDITOR_ADMIN_BYPASS.trim()) {
    throw new Error('Set EDITOR_ADMIN_BYPASS at the top of Code.gs in the Apps Script editor first.');
  }
  PropertiesService.getScriptProperties().setProperty('ADMIN_BYPASS', EDITOR_ADMIN_BYPASS.trim());
}

function generateWriteToken() {
  return Utilities.getUuid().replace(/-/g, '');
}

function findMatchRow(matchId, matchData) {
  var data = matchData || getSheetData('Matches');
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === matchId) {
      return {
        sheetRow: i + 1,
        data: data[i],
        writeToken: (data[i][9] || '').toString(),
        totalCost: Number(data[i][3]) || 0,
        status: data[i][8],
        splitMode: normalizeSplitMode((data[i][10] || '').toString())
      };
    }
  }
  return null;
}

function validateWriteToken(matchId, token) {
  var info = findMatchRow(matchId);
  if (!info) return { ok: false, error: 'Match not found' };
  var provided = token ? token.toString().trim() : '';
  if (!provided) return { ok: false, error: 'Invalid or missing write token' };
  var bypass = getAdminBypassToken();
  if (bypass && provided === bypass) return { ok: true };
  var stored = (info.writeToken || '').toString().trim();
  if (!stored) return { ok: false, error: 'Write token not configured — run backfillWriteTokens() in Apps Script' };
  if (provided !== stored) return { ok: false, error: 'Invalid or missing write token' };
  return { ok: true };
}

function requireWriteToken(body) {
  var auth = validateWriteToken(body.matchId, body.writeToken);
  if (!auth.ok) return auth.error;
  return null;
}

// Prevent Google Sheets formula injection (OWASP: injection defence)
function sanitize(val, maxLen) {
  if (val === null || val === undefined) return '';
  var s = val.toString().trim();
  if (maxLen && s.length > maxLen) s = s.substring(0, maxLen);
  // Prefix with apostrophe if starts with formula trigger chars (=, +, -, @, tab, CR)
  if (s.length > 0 && '=+-@\t\r'.indexOf(s[0]) !== -1) s = "'" + s;
  return s;
}

function getSheet(name) {
  return getSpreadsheet().getSheetByName(name);
}

// Per-request sheet cache — avoids repeated getDataRange() in one API call
var _req = { ss: null, sheets: {} };

function beginRequest() {
  _req = { ss: null, sheets: {} };
}

function getSpreadsheetCached() {
  if (_req.ss) return _req.ss;
  _req.ss = getSpreadsheet();
  return _req.ss;
}

function getSheetCached(name) {
  return getSpreadsheetCached().getSheetByName(name);
}

function getSheetData(name) {
  if (_req.sheets[name]) return _req.sheets[name];
  var sheet = getSheetCached(name);
  if (!sheet) {
    _req.sheets[name] = [];
    return _req.sheets[name];
  }
  _req.sheets[name] = sheet.getDataRange().getValues();
  return _req.sheets[name];
}

function invalidateSheetData(name) {
  delete _req.sheets[name];
}

function buildPaymentIndex(paymentData) {
  var index = {};
  for (var j = 1; j < paymentData.length; j++) {
    var matchId = paymentData[j][0];
    if (!index[matchId]) index[matchId] = { playerCount: 0, paidCount: 0, paidAmount: 0 };
    index[matchId].playerCount++;
    if (paymentData[j][4] === true || paymentData[j][4] === 'TRUE') {
      index[matchId].paidCount++;
      index[matchId].paidAmount += Number(paymentData[j][3]) || 0;
    }
  }
  return index;
}

// --- Web App Entry Points ---

function doGet(e) {
  beginRequest();
  const action = (e.parameter && e.parameter.action) || '';
  let result;
  try {
    switch (action) {
      case 'matches':
        result = getMatches();
        break;
      case 'match':
        result = getMatch(e.parameter.id);
        break;
      case 'players':
        result = getPlayers();
        break;
      case 'playerHistory':
        result = getPlayerHistory(e.parameter.id);
        break;
      case 'scrape':
        result = scrapePlayerNames(e.parameter.url);
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  beginRequest();
  let result;
  try {
    if (!e.postData || !e.postData.contents) throw new Error('Empty request body');
    const body = JSON.parse(e.postData.contents);
    const action = body.action || '';
    switch (action) {
      case 'createMatch':
        result = createMatch(body);
        break;
      case 'checkIn':
        result = checkIn(body);
        break;
      case 'checkInBatch':
        result = checkInBatch(body);
        break;
      case 'removePlayer':
        result = removePlayer(body);
        break;
      case 'lockMatch':
        result = lockMatch(body);
        break;
      case 'setPlayerAmount':
        result = setPlayerAmount(body);
        break;
      case 'markPaid':
        result = markPaid(body);
        break;
      case 'deleteMatch':
        result = deleteMatch(body);
        break;
      case 'renamePlayer':
        result = renamePlayer(body);
        break;
      case 'deletePlayer':
        result = deletePlayer(body);
        break;
      case 'addPlayer':
        result = addPlayer(body);
        break;
      case 'validateAdmin':
        result = validateAdmin(body.token);
        break;
      case 'purgeTestData':
        result = purgeTestData(body);
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// --- Matches ---

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function formatDateStr(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return val ? val.toString().split('T')[0] : '';
}

function createMatch(body) {
  const sheet = getSheet('Matches');
  const date = sanitize(body.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'), 20);
  const payTo = sanitize(body.payTo, MAX_FIELD_LEN);
  const payToUPI = sanitize(body.payToUPI, MAX_FIELD_LEN);
  if (!payTo) return { error: 'payTo is required' };

  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    var matchId;
    var matchData = getSheetData('Matches');
    var existingIds = {};
    for (var i = 1; i < matchData.length; i++) existingIds[matchData[i][0]] = true;
    for (var attempt = 0; attempt < 5; attempt++) {
      var candidate = generateId();
      if (!existingIds[candidate]) { matchId = candidate; break; }
    }
    if (!matchId) matchId = generateId() + generateId();

    var writeToken = generateWriteToken();
    var accentColor = sanitize(body.accentColor || '', 20);
    sheet.appendRow([matchId, date, '', 0, 0, 0, payTo, payToUPI, 'checkin', writeToken, 'equal', accentColor]);
    invalidateSheetData('Matches');

    var result = { success: true, matchId: matchId, writeToken: writeToken };
    if (body.checkInCollector && payTo) {
      var ci = checkIn({ matchId: matchId, playerName: payTo }, { noLock: true });
      if (ci.error) result.checkInError = ci.error;
      else result.checkIn = ci;
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

function getMatches() {
  const matchData = getSheetData('Matches');
  const paymentData = getSheetData('Payments');
  const payIndex = buildPaymentIndex(paymentData);

  if (matchData.length <= 1) return { matches: [] };

  const matches = [];
  for (let i = 1; i < matchData.length; i++) {
    const row = matchData[i];
    const matchId = row[0];
    const totalCost = Number(row[3]) || 0;
    const stats = payIndex[matchId] || { playerCount: 0, paidCount: 0, paidAmount: 0 };

    matches.push({
      matchId: matchId,
      date: formatDateStr(row[1]),
      cricheroes: row[2],
      totalCost: totalCost,
      perPlayerCost: Number(row[4]) || 0,
      playerCount: stats.playerCount,
      payTo: row[6],
      payToUPI: row[7],
      status: row[8],
      paidCount: stats.paidCount,
      paidAmount: stats.paidAmount,
      splitMode: normalizeSplitMode((row[10] || '').toString()),
      accentColor: (row[11] || '').toString()
    });
  }

  // Sort newest first
  matches.sort(function(a, b) {
    var da = new Date(a.date), db = new Date(b.date);
    if (isNaN(da)) da = new Date(0);
    if (isNaN(db)) db = new Date(0);
    return db - da;
  });

  return { matches: matches };
}

function getMatch(matchId) {
  if (!matchId) return { error: 'Missing matchId' };

  const info = findMatchRow(matchId);
  if (!info) return { error: 'Match not found' };

  const row = info.data;
  const match = {
    matchId: row[0],
    date: formatDateStr(row[1]),
    cricheroes: row[2],
    totalCost: Number(row[3]) || 0,
    perPlayerCost: Number(row[4]) || 0,
    playerCount: 0,
    payTo: row[6],
    payToUPI: row[7],
    status: row[8],
    requiresWriteToken: true,
    splitMode: normalizeSplitMode((row[10] || '').toString()),
    accentColor: (row[11] || '').toString()
  };

  const paymentData = getSheetData('Payments');
  const players = [];

  for (let j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId) {
      players.push({
        name: paymentData[j][1],
        playerId: paymentData[j][2],
        amountOwed: Number(paymentData[j][3]) || 0,
        paid: paymentData[j][4] === true || paymentData[j][4] === 'TRUE',
        paidTimestamp: paymentData[j][5] || ''
      });
    }
  }

  match.players = players;
  match.playerCount = players.length;
  match.paidCount = players.filter(function(p) { return p.paid; }).length;
  match.paidAmount = players.filter(function(p) { return p.paid; }).reduce(function(s, p) { return s + p.amountOwed; }, 0);

  return { match: match };
}

function normalizeSplitMode(mode) {
  return (mode && mode.toString().trim() === 'exact') ? 'exact' : 'equal';
}

function sumAssignedAmounts(matchId) {
  var paymentData = getSheetData('Payments');
  var sum = 0;
  for (var j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId) {
      sum += Number(paymentData[j][3]) || 0;
    }
  }
  return sum;
}

function getPlayersForMatch(matchId) {
  var paymentData = getSheetData('Payments');
  var players = [];
  for (var j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId) {
      players.push({
        name: paymentData[j][1],
        playerId: paymentData[j][2],
        amountOwed: Number(paymentData[j][3]) || 0,
        paid: paymentData[j][4] === true || paymentData[j][4] === 'TRUE',
        paidTimestamp: paymentData[j][5] || ''
      });
    }
  }
  return players;
}

// --- Check-in ---

function checkIn(body, options) {
  options = options || {};
  const matchId = body.matchId;
  const playerName = sanitize(body.playerName, MAX_NAME_LEN);

  if (!matchId || !playerName) return { error: 'Missing matchId or playerName' };

  var lock = null;
  if (!options.noLock) {
    lock = LockService.getScriptLock();
    lock.waitLock(8000);
  }
  try {
    const matchSheet = getSheetCached('Matches');
    const matchData = getSheetData('Matches');
    let matchRow = -1;
    let currentPerPlayerCost = 0;
    let totalCost = 0;
    let splitMode = 'equal';
    for (let i = 1; i < matchData.length; i++) {
      if (matchData[i][0] === matchId) {
        matchRow = i + 1;
        totalCost = Number(matchData[i][3]) || 0;
        currentPerPlayerCost = Number(matchData[i][4]) || 0;
        splitMode = normalizeSplitMode((matchData[i][10] || '').toString());
        break;
      }
    }
    if (matchRow === -1) return { error: 'Match not found' };

    const paymentSheet = getSheetCached('Payments');
    const paymentData = getSheetData('Payments');
    for (let j = 1; j < paymentData.length; j++) {
      if (paymentData[j][0] === matchId && paymentData[j][1].toString().toLowerCase() === playerName.toLowerCase()) {
        return { error: 'Player already checked in' };
      }
    }

    const playerId = getOrCreatePlayer(playerName);
    var amountOwed = 0;
    if (totalCost > 0 && splitMode === 'equal' && currentPerPlayerCost > 0) {
      amountOwed = currentPerPlayerCost;
    }

    paymentSheet.appendRow([matchId, playerName, playerId, amountOwed, false, '']);
    invalidateSheetData('Payments');

    if (totalCost > 0 && splitMode === 'equal') {
      var split = applySplitToMatch(matchId, matchRow, totalCost, matchSheet, paymentSheet, 'equal');
      return {
        success: true,
        playerName: playerName,
        perPlayerCost: split.perPlayerCost,
        playerCount: split.playerCount,
        totalCost: totalCost,
        splitMode: 'equal'
      };
    }

    if (totalCost > 0 && splitMode === 'exact') {
      var playerCount = countMatchPlayers(matchId);
      updateMatchCostMeta(matchRow, totalCost, playerCount, matchSheet, 'exact');
      return {
        success: true,
        playerName: playerName,
        playerCount: playerCount,
        totalCost: totalCost,
        splitMode: 'exact',
        assigned: sumAssignedAmounts(matchId),
        remaining: totalCost - sumAssignedAmounts(matchId)
      };
    }

    return { success: true, playerName: playerName, playerCount: countMatchPlayers(matchId) };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function countMatchPlayers(matchId) {
  var paymentData = getSheetData('Payments');
  var count = 0;
  for (var j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId) count++;
  }
  return count;
}

function checkInBatch(body) {
  const matchId = body.matchId;
  const rawNames = body.playerNames;

  if (!matchId || !rawNames || !rawNames.length) return { error: 'Missing matchId or playerNames' };
  if (rawNames.length > 50) return { error: 'Batch too large (max 50)' };

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const matchSheet = getSheetCached('Matches');
    const matchData = getSheetData('Matches');
    let matchRow = -1;
    let totalCost = 0;
    let splitMode = 'equal';
    for (let i = 1; i < matchData.length; i++) {
      if (matchData[i][0] === matchId) {
        matchRow = i + 1;
        totalCost = Number(matchData[i][3]) || 0;
        splitMode = normalizeSplitMode((matchData[i][10] || '').toString());
        break;
      }
    }
    if (matchRow === -1) return { error: 'Match not found' };

    const paymentSheet = getSheetCached('Payments');
    const paymentData = getSheetData('Payments');
    const existingLower = {};
    for (let j = 1; j < paymentData.length; j++) {
      if (paymentData[j][0] === matchId) {
        existingLower[paymentData[j][1].toString().toLowerCase()] = true;
      }
    }

    const rowsToAdd = [];
    let added = 0;
    let skipped = 0;

    for (let n = 0; n < rawNames.length; n++) {
      const playerName = sanitize(rawNames[n], MAX_NAME_LEN);
      if (!playerName) continue;
      const key = playerName.toLowerCase();
      if (existingLower[key]) {
        skipped++;
        continue;
      }
      const playerId = getOrCreatePlayer(playerName);
      rowsToAdd.push([matchId, playerName, playerId, 0, false, '']);
      existingLower[key] = true;
      added++;
    }

    if (rowsToAdd.length > 0) {
      const startRow = paymentSheet.getLastRow() + 1;
      paymentSheet.getRange(startRow, 1, rowsToAdd.length, 6).setValues(rowsToAdd);
      invalidateSheetData('Payments');
    }

    const result = { success: true, added: added, skipped: skipped, splitMode: splitMode };
    if (totalCost > 0 && rowsToAdd.length > 0) {
      if (splitMode === 'equal') {
        const split = applySplitToMatch(matchId, matchRow, totalCost, matchSheet, paymentSheet, 'equal');
        result.perPlayerCost = split.perPlayerCost;
        result.playerCount = split.playerCount;
        result.totalCost = totalCost;
      } else {
        var batchCount = countMatchPlayers(matchId);
        updateMatchCostMeta(matchRow, totalCost, batchCount, matchSheet, 'exact');
        result.playerCount = batchCount;
        result.totalCost = totalCost;
        result.assigned = sumAssignedAmounts(matchId);
        result.remaining = totalCost - result.assigned;
      }
    } else if (rowsToAdd.length > 0) {
      result.playerCount = countMatchPlayers(matchId);
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

function getOrCreatePlayer(name) {
  const sheet = getSheetCached('Players');
  const data = getSheetData('Players');
  const nameLower = name.toLowerCase();

  for (let i = 1; i < data.length; i++) {
    if (data[i][1].toString().toLowerCase() === nameLower) {
      return data[i][0];
    }
  }

  const playerId = generateId();
  sheet.appendRow([playerId, name, '']);
  invalidateSheetData('Players');
  return playerId;
}

// --- Remove Player ---

function removePlayer(body) {
  const matchId = body.matchId;
  const playerName = sanitize(body.playerName, MAX_NAME_LEN);

  if (!matchId || !playerName) return { error: 'Missing matchId or playerName' };

  var tokenErr = requireWriteToken(body);
  if (tokenErr) return { error: tokenErr };

  var matchInfo = findMatchRow(matchId);
  if (!matchInfo) return { error: 'Match not found' };

  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    const matchSheet = getSheetCached('Matches');
    const paymentSheet = getSheetCached('Payments');
    const paymentData = getSheetData('Payments');
    var removed = false;

    for (let j = paymentData.length - 1; j >= 1; j--) {
      if (paymentData[j][0] === matchId && paymentData[j][1].toString().toLowerCase() === playerName.toLowerCase()) {
        paymentSheet.deleteRow(j + 1);
        invalidateSheetData('Payments');
        removed = true;
        break;
      }
    }

    if (!removed) return { error: 'Player not found in this match' };

    if (matchInfo.totalCost > 0) {
      var remaining = countMatchPlayers(matchId);
      if (remaining === 0) {
        return { success: true, playerName: playerName, playerCount: 0 };
      }
      var splitMode = matchInfo.splitMode || normalizeSplitMode((matchInfo.data[10] || '').toString());
      if (splitMode === 'equal') {
        var split = applySplitToMatch(matchId, matchInfo.sheetRow, matchInfo.totalCost, matchSheet, paymentSheet, 'equal');
        return {
          success: true,
          playerName: playerName,
          perPlayerCost: split.perPlayerCost,
          playerCount: split.playerCount,
          totalCost: matchInfo.totalCost,
          splitMode: 'equal'
        };
      }
      updateMatchCostMeta(matchInfo.sheetRow, matchInfo.totalCost, remaining, matchSheet, 'exact');
      return {
        success: true,
        playerName: playerName,
        playerCount: remaining,
        totalCost: matchInfo.totalCost,
        splitMode: 'exact',
        assigned: sumAssignedAmounts(matchId),
        remaining: matchInfo.totalCost - sumAssignedAmounts(matchId)
      };
    }

    return { success: true, playerName: playerName };
  } finally {
    lock.releaseLock();
  }
}

// --- Lock Match ---

function updateMatchCostMeta(matchRow, totalCost, playerCount, matchSheet, splitMode) {
  var perPlayerCost = playerCount > 0 ? Math.ceil(totalCost / playerCount) : 0;
  matchSheet.getRange(matchRow, 4, 1, 3).setValues([[totalCost, perPlayerCost, playerCount]]);
  matchSheet.getRange(matchRow, 11).setValue(normalizeSplitMode(splitMode));
  invalidateSheetData('Matches');
}

function applySplitToMatch(matchId, matchRow, totalCost, matchSheet, paymentSheet, splitMode) {
  splitMode = normalizeSplitMode(splitMode);
  const paymentData = getSheetData('Payments');
  const playerRows = [];
  for (let j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId) {
      playerRows.push(j + 1);
    }
  }
  if (playerRows.length === 0) return { perPlayerCost: 0, playerCount: 0, splitMode: splitMode };

  const perPlayerCost = Math.ceil(totalCost / playerRows.length);
  matchSheet.getRange(matchRow, 4, 1, 3).setValues([[totalCost, perPlayerCost, playerRows.length]]);
  matchSheet.getRange(matchRow, 11).setValue(splitMode);

  if (splitMode === 'exact') {
    var assigned = 0;
    for (let j = 1; j < paymentData.length; j++) {
      if (paymentData[j][0] === matchId) {
        assigned += Number(paymentData[j][3]) || 0;
      }
    }
    if (assigned === 0) {
      if (playerRows.length === 1) {
        paymentSheet.getRange(playerRows[0], 4).setValue(perPlayerCost);
      } else {
        paymentSheet.getRangeList(
          playerRows.map(function(row) { return paymentSheet.getRange(row, 4).getA1Notation(); })
        ).setValue(perPlayerCost);
      }
      invalidateSheetData('Payments');
      assigned = perPlayerCost * playerRows.length;
    }
    invalidateSheetData('Matches');
    return {
      perPlayerCost: perPlayerCost,
      playerCount: playerRows.length,
      totalCost: totalCost,
      splitMode: 'exact',
      assigned: sumAssignedAmounts(matchId),
      remaining: totalCost - sumAssignedAmounts(matchId),
      players: getPlayersForMatch(matchId)
    };
  }

  if (playerRows.length === 1) {
    paymentSheet.getRange(playerRows[0], 4).setValue(perPlayerCost);
  } else {
    paymentSheet.getRangeList(
      playerRows.map(function(row) { return paymentSheet.getRange(row, 4).getA1Notation(); })
    ).setValue(perPlayerCost);
  }
  invalidateSheetData('Matches');
  invalidateSheetData('Payments');
  return {
    perPlayerCost: perPlayerCost,
    playerCount: playerRows.length,
    totalCost: totalCost,
    splitMode: 'equal',
    players: getPlayersForMatch(matchId)
  };
}

function lockMatch(body) {
  const matchId = body.matchId;
  const totalCost = Number(body.totalCost);

  if (!matchId || !totalCost || totalCost <= 0) return { error: 'Missing matchId or invalid totalCost' };

  var tokenErr = requireWriteToken(body);
  if (tokenErr) return { error: tokenErr };

  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    const matchSheet = getSheetCached('Matches');
    const matchData = getSheetData('Matches');
    let matchRow = -1;
    let existingMode = 'equal';

    for (let i = 1; i < matchData.length; i++) {
      if (matchData[i][0] === matchId) {
        matchRow = i + 1;
        existingMode = normalizeSplitMode((matchData[i][10] || '').toString());
        break;
      }
    }
    if (matchRow === -1) return { error: 'Match not found' };

    const splitMode = body.splitMode ? normalizeSplitMode(body.splitMode) : existingMode;
    const paymentSheet = getSheetCached('Payments');
    const split = applySplitToMatch(matchId, matchRow, totalCost, matchSheet, paymentSheet, splitMode);
    if (split.playerCount === 0) return { error: 'No players checked in' };

    return {
      success: true,
      perPlayerCost: split.perPlayerCost,
      playerCount: split.playerCount,
      totalCost: totalCost,
      splitMode: split.splitMode || splitMode,
      assigned: split.assigned,
      remaining: split.remaining,
      players: split.players || getPlayersForMatch(matchId)
    };
  } finally {
    lock.releaseLock();
  }
}

function setPlayerAmount(body) {
  const matchId = body.matchId;
  const playerName = sanitize(body.playerName, MAX_NAME_LEN);
  const amountOwed = Number(body.amountOwed);

  if (!matchId || !playerName) return { error: 'Missing matchId or playerName' };
  if (isNaN(amountOwed) || amountOwed < 0) return { error: 'Invalid amount' };

  var tokenErr = requireWriteToken(body);
  if (tokenErr) return { error: tokenErr };

  var matchInfo = findMatchRow(matchId);
  if (!matchInfo) return { error: 'Match not found' };
  if (matchInfo.totalCost <= 0) return { error: 'Set total cost first' };
  if (matchInfo.splitMode !== 'exact') return { error: 'Custom amounts only in exact split mode' };

  const paymentSheet = getSheetCached('Payments');
  const paymentData = getSheetData('Payments');

  for (let j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId && paymentData[j][1].toString().toLowerCase() === playerName.toLowerCase()) {
      var rounded = Math.round(amountOwed * 100) / 100;
      paymentSheet.getRange(j + 1, 4).setValue(rounded);
      invalidateSheetData('Payments');
      var assigned = sumAssignedAmounts(matchId);
      return {
        success: true,
        playerName: playerName,
        amountOwed: rounded,
        assigned: assigned,
        remaining: matchInfo.totalCost - assigned,
        totalCost: matchInfo.totalCost,
        players: getPlayersForMatch(matchId)
      };
    }
  }

  return { error: 'Player not found in this match' };
}

// --- Mark Paid ---

function markPaid(body) {
  const matchId = body.matchId;
  const playerName = sanitize(body.playerName, MAX_NAME_LEN);
  const paid = body.paid !== false; // default to true

  if (!matchId || !playerName) return { error: 'Missing matchId or playerName' };

  // TRUST MODEL: No write token required for marking paid.
  // Players mark themselves paid from the shared link (WhatsApp group).
  // This means anyone with the link CAN mark another player as paid.
  // Acceptable trade-off for a friends-based cricket group app.
  //
  // RESTRICTION: Un-marking (paid -> unpaid) requires write token / admin.
  // This prevents griefing while keeping the open-mark-paid flow.
  if (!paid) {
    var tokenErr = requireWriteToken(body);
    if (tokenErr) return { error: 'Only match admin can un-mark a payment' };
  }

  const paymentSheet = getSheetCached('Payments');
  const paymentData = getSheetData('Payments');

  for (let j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId && paymentData[j][1].toString().toLowerCase() === playerName.toLowerCase()) {
      const row = j + 1;
      const amountOwed = Number(paymentData[j][3]) || 0;
      paymentSheet.getRange(row, 5, 1, 2).setValues([[paid, paid ? new Date().toISOString() : '']]);
      invalidateSheetData('Payments');
      return { success: true, paid: paid, amountOwed: amountOwed, playerName: playerName };
    }
  }

  return { error: 'Player not found in this match' };
}

// --- Delete Match ---

function deleteMatch(body) {
  var matchId = body.matchId;
  if (!matchId) return { error: 'matchId required' };

  var tokenErr = requireWriteToken(body);
  if (tokenErr) return { error: tokenErr };

  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    var matchSheet = getSheetCached('Matches');
    var matchData = getSheetData('Matches');
    var matchRow = -1;
    for (var i = 1; i < matchData.length; i++) {
      if (matchData[i][0] === matchId) {
        matchRow = i + 1;
        break;
      }
    }
    if (matchRow === -1) return { error: 'Match not found' };

    matchSheet.deleteRow(matchRow);
    invalidateSheetData('Matches');

    var paymentSheet = getSheetCached('Payments');
    var paymentData = getSheetData('Payments');
    for (var j = paymentData.length - 1; j >= 1; j--) {
      if (paymentData[j][0] === matchId) {
        paymentSheet.deleteRow(j + 1);
      }
    }
    invalidateSheetData('Payments');

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// --- Player Stats ---

function getPlayers() {
  const playerData = getSheetData('Players');
  const paymentData = getSheetData('Payments');

  // Build roster from Players sheet (source of truth)
  const roster = {};
  for (let i = 1; i < playerData.length; i++) {
    const pid = playerData[i][0].toString();
    const name = playerData[i][1].toString();
    if (!pid || !name) continue;
    roster[pid] = { playerId: pid, name: name, matches: 0, totalOwed: 0, totalPaid: 0, outstanding: 0 };
  }

  // Enrich with stats from Payments sheet
  for (let j = 1; j < paymentData.length; j++) {
    const pid = (paymentData[j][2] || '').toString();
    const name = paymentData[j][1].toString();
    if (!name) continue;
    const amountOwed = Number(paymentData[j][3]) || 0;
    const paid = paymentData[j][4] === true || paymentData[j][4] === 'TRUE';

    if (pid && roster[pid]) {
      roster[pid].matches++;
      roster[pid].totalOwed += amountOwed;
      if (paid) roster[pid].totalPaid += amountOwed;
      if (name && roster[pid].name !== name) roster[pid].name = name;
    } else {
      // Payment row without a Players-sheet entry (legacy data)
      const nameLower = name.toLowerCase();
      const fallbackKey = '_name_' + nameLower;
      if (!roster[fallbackKey]) {
        roster[fallbackKey] = { playerId: '', name: name, matches: 0, totalOwed: 0, totalPaid: 0, outstanding: 0 };
      }
      roster[fallbackKey].matches++;
      roster[fallbackKey].totalOwed += amountOwed;
      if (paid) roster[fallbackKey].totalPaid += amountOwed;
    }
  }

  const players = Object.values(roster).map(function(p) {
    p.outstanding = p.totalOwed - p.totalPaid;
    return p;
  });

  players.sort(function(a, b) { return b.matches - a.matches || a.name.localeCompare(b.name); });

  return { players: players };
}

// --- Player History (per-match breakdown) ---

function getPlayerHistory(playerId) {
  if (!playerId) return { error: 'Missing player ID' };

  var playerData = getSheetData('Players');
  var playerName = '';
  for (var i = 1; i < playerData.length; i++) {
    if (playerData[i][0].toString() === playerId) {
      playerName = playerData[i][1].toString();
      break;
    }
  }
  if (!playerName) return { error: 'Player not found' };

  var matchData = getSheetData('Matches');
  var matchMap = {};
  for (var m = 1; m < matchData.length; m++) {
    matchMap[matchData[m][0]] = {
      date: formatDateStr(matchData[m][1]),
      payTo: matchData[m][6] || '',
      totalCost: Number(matchData[m][3]) || 0
    };
  }

  var paymentData = getSheetData('Payments');
  var history = [];
  for (var j = 1; j < paymentData.length; j++) {
    var pid = (paymentData[j][2] || '').toString();
    if (pid !== playerId) continue;
    var matchId = paymentData[j][0];
    var matchInfo = matchMap[matchId] || {};
    history.push({
      matchId: matchId,
      date: matchInfo.date || '',
      payTo: matchInfo.payTo || '',
      amount: Number(paymentData[j][3]) || 0,
      paid: paymentData[j][4] === true || paymentData[j][4] === 'TRUE',
      paidTimestamp: paymentData[j][5] || ''
    });
  }

  history.sort(function(a, b) {
    var da = new Date(a.date), db = new Date(b.date);
    if (isNaN(da)) da = new Date(0);
    if (isNaN(db)) db = new Date(0);
    return db - da;
  });

  return { playerId: playerId, name: playerName, history: history };
}

// --- Rename Player ---

function renamePlayer(body) {
  const playerId = (body.playerId || '').toString().trim();
  const newName = sanitize(body.newName, MAX_NAME_LEN);

  if (!newName) return { error: 'New name is required' };

  var bypass = getAdminBypassToken();
  var token = (body.writeToken || body.token || '').toString().trim();
  if (!bypass || token !== bypass) {
    return { error: 'Admin access required' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    var updated = 0;

    if (playerId) {
      // Rename by playerId in Players sheet
      var playerSheet = getSheetCached('Players');
      var playerData = getSheetData('Players');
      var playerFound = false;
      for (var i = 1; i < playerData.length; i++) {
        if (playerData[i][0].toString() === playerId) {
          playerSheet.getRange(i + 1, 2).setValue(newName);
          playerFound = true;
          break;
        }
      }
      if (!playerFound) return { error: 'Player not found' };
      invalidateSheetData('Players');

      // Update all Payments rows that reference this playerId
      var paymentSheet = getSheetCached('Payments');
      var paymentData = getSheetData('Payments');
      for (var j = 1; j < paymentData.length; j++) {
        if ((paymentData[j][2] || '').toString() === playerId) {
          paymentSheet.getRange(j + 1, 2).setValue(newName);
          updated++;
        }
      }
      invalidateSheetData('Payments');
    } else if (body.oldName) {
      // Fallback: rename by name (for legacy players without IDs)
      var oldName = sanitize(body.oldName, MAX_NAME_LEN);
      var oldLower = oldName.toLowerCase();

      var paymentSheet2 = getSheetCached('Payments');
      var paymentData2 = getSheetData('Payments');
      for (var k = 1; k < paymentData2.length; k++) {
        if (paymentData2[k][1].toString().toLowerCase() === oldLower) {
          paymentSheet2.getRange(k + 1, 2).setValue(newName);
          updated++;
        }
      }
      invalidateSheetData('Payments');

      var playerSheet2 = getSheetCached('Players');
      var playerData2 = getSheetData('Players');
      for (var m = 1; m < playerData2.length; m++) {
        if (playerData2[m][1].toString().toLowerCase() === oldLower) {
          playerSheet2.getRange(m + 1, 2).setValue(newName);
          break;
        }
      }
      invalidateSheetData('Players');
    } else {
      return { error: 'playerId or oldName is required' };
    }

    return { success: true, updated: updated };
  } finally {
    lock.releaseLock();
  }
}

// --- Delete Player ---

function deletePlayer(body) {
  const playerId = (body.playerId || '').toString().trim();
  if (!playerId) return { error: 'playerId is required' };

  var bypass = getAdminBypassToken();
  var token = (body.writeToken || body.token || '').toString().trim();
  if (!bypass || token !== bypass) return { error: 'Admin access required' };

  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    var playerSheet = getSheetCached('Players');
    var playerData = getSheetData('Players');
    var playerNameLower = '';
    for (var i = 1; i < playerData.length; i++) {
      if (playerData[i][0].toString() === playerId) {
        playerNameLower = (playerData[i][1] || '').toString().toLowerCase();
        break;
      }
    }

    var paymentData = getSheetData('Payments');
    for (var j = 1; j < paymentData.length; j++) {
      var payPid = (paymentData[j][2] || '').toString();
      if (payPid === playerId) {
        return { error: 'Player has match history — remove from individual matches first' };
      }
      if (playerNameLower && !payPid &&
          paymentData[j][1].toString().toLowerCase() === playerNameLower) {
        return { error: 'Player has match history — remove from individual matches first' };
      }
    }

    var deleted = false;
    for (var k = 1; k < playerData.length; k++) {
      if (playerData[k][0].toString() === playerId) {
        playerSheet.deleteRow(k + 1);
        invalidateSheetData('Players');
        deleted = true;
        break;
      }
    }
    if (!deleted) return { error: 'Player not found' };
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// --- Add Player (pre-register to roster) ---

function addPlayer(body) {
  var playerName = sanitize(body.playerName, MAX_NAME_LEN);
  if (!playerName) return { error: 'Player name is required' };

  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    var sheet = getSheetCached('Players');
    var data = getSheetData('Players');
    for (var i = 1; i < data.length; i++) {
      if (data[i][1].toString().toLowerCase() === playerName.toLowerCase()) {
        return { error: 'Player already exists' };
      }
    }
    var playerId = generateId();
    sheet.appendRow([playerId, playerName, '']);
    invalidateSheetData('Players');
    return { success: true, playerId: playerId, playerName: playerName };
  } finally {
    lock.releaseLock();
  }
}

// --- CricHeroes Scraping (Optional) ---

function cleanCricHeroesName(name) {
  if (!name) return '';
  var s = name.toString();
  s = s.replace(/&#(\d+);/g, function(_, code) { return String.fromCharCode(Number(code)); });
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
  return s.replace(/\s+/g, ' ').trim();
}

function encodeUrlParens(urlStr) {
  return urlStr.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function buildScorecardUrls(urlStr) {
  var scorecardUrl = urlStr.replace(/\/summary\/?$/, '/scorecard')
    .replace(/\/commentary\/?$/, '/scorecard')
    .replace(/\/analysis\/?$/, '/scorecard');
  if (!/\/scorecard\/?$/.test(scorecardUrl)) {
    scorecardUrl = scorecardUrl.replace(/\/?$/, '/scorecard');
  }
  var urls = [scorecardUrl];
  var alt = scorecardUrl.indexOf('cricheroes.in') >= 0
    ? scorecardUrl.replace('cricheroes.in', 'cricheroes.com')
    : scorecardUrl.replace('cricheroes.com', 'cricheroes.in');
  if (alt !== scorecardUrl) urls.push(alt);
  return urls.map(encodeUrlParens);
}

function parsePlayersFromNextData(html) {
  var m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  var players = [];
  var seen = {};
  function add(name, profileId) {
    name = cleanCricHeroesName(name);
    if (!name || name.length < 2) return;
    var key = name.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    players.push({ name: name, profileId: profileId ? String(profileId) : '' });
  }
  try {
    var data = JSON.parse(m[1]);
    var teams = data && data.props && data.props.pageProps && data.props.pageProps.scorecard;
    if (!Array.isArray(teams)) return [];
    teams.forEach(function(team) {
      (team.batting || []).forEach(function(p) { add(p.name, p.player_id); });
      (team.to_be_bat || []).forEach(function(p) { add(p.name, p.player_id); });
      (team.bowling || []).forEach(function(p) { add(p.name, p.player_id); });
    });
  } catch (e) {
    Logger.log('__NEXT_DATA__ parse failed: ' + e.message);
  }
  return players;
}

function fetchScorecardHtml(urlCandidates) {
  var headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://cricheroes.com/'
  };
  var best = { html: '', url: '', len: 0 };
  for (var i = 0; i < urlCandidates.length; i++) {
    try {
      var response = UrlFetchApp.fetch(urlCandidates[i], {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: headers
      });
      if (response.getResponseCode() !== 200) continue;
      var html = response.getContentText();
      if (html.length > best.len) {
        best = { html: html, url: urlCandidates[i], len: html.length };
      }
      if (html.indexOf('__NEXT_DATA__') >= 0 && html.length > 20000) break;
    } catch (e) {
      Logger.log('Fetch failed for ' + urlCandidates[i] + ': ' + e.message);
    }
  }
  return best;
}

function scrapePlayerNames(url) {
  if (!url) return { error: 'Missing URL' };

  // Only allow CricHeroes domains — regex host check (URL() fails on slugs with parentheses)
  var urlStr = url.toString().trim();
  if (!/^https?:\/\//i.test(urlStr)) {
    return { players: [], note: 'Invalid URL' };
  }
  var hostMatch = urlStr.match(/^https?:\/\/([^\/\?#]+)/i);
  var parsedHost = hostMatch ? hostMatch[1].toLowerCase() : '';
  var allowedHost = parsedHost === 'cricheroes.in' || parsedHost === 'cricheroes.com' ||
                    parsedHost.endsWith('.cricheroes.in') || parsedHost.endsWith('.cricheroes.com');
  if (!allowedHost) {
    return { players: [], note: 'Only CricHeroes URLs are supported' };
  }

  var scorecardUrls = buildScorecardUrls(urlStr);
  var scorecardUrl = scorecardUrls[0];

  // Extract match ID from URL to try the JSON API first
  var matchIdMatch = scorecardUrl.match(/\/scorecard\/(\d+)\//);
  if (matchIdMatch) {
    var cricMatchId = matchIdMatch[1];
    try {
      var apiUrl = 'https://rest.cricheroes.in/api/v1/match/' + cricMatchId + '/scorecard';
      var apiResp = UrlFetchApp.fetch(apiUrl, {
        muteHttpExceptions: true,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        }
      });
      if (apiResp.getResponseCode() === 200) {
        var apiData = JSON.parse(apiResp.getContentText());
        var players = [];
        var seen = {};
        // Traverse common API shapes
        function extractFromObj(obj) {
          if (!obj || typeof obj !== 'object') return;
          if (obj.player_name && !seen[obj.player_name]) {
            seen[obj.player_name] = true;
            players.push({ name: obj.player_name, profileId: (obj.player_id || '').toString() });
          }
          Object.values(obj).forEach(function(v) {
            if (Array.isArray(v)) v.forEach(extractFromObj);
            else if (v && typeof v === 'object') extractFromObj(v);
          });
        }
        extractFromObj(apiData);
        if (players.length > 0) return { players: players, source: 'api' };
      }
    } catch(e) {
      Logger.log('API attempt failed: ' + e.message);
    }
  }

  // Scrape HTML scorecard page (try .in / .com, encode parentheses in URL)
  var fetched = fetchScorecardHtml(scorecardUrls);
  var html = fetched.html || '';
  Logger.log('Scrape response length: ' + html.length + ' for URL: ' + fetched.url);
  if (html.length > 3000000) html = html.substring(0, 3000000);

  var nextPlayers = parsePlayersFromNextData(html);
  if (nextPlayers.length > 0) {
    return { players: nextPlayers, source: 'next_data', htmlLength: html.length };
  }

  var players = [];
  var seen = {};

  // Extract player names from profile links: /player-profile/ID/NAME/matches
  var profileRegex = /\/player-profile\/(\d+)\/([^\/\"]+)/g;
  var match;
  while ((match = profileRegex.exec(html)) !== null) {
    var profileId = match[1];
    var rawName = decodeURIComponent(match[2]).replace(/-/g, ' ');
    var name = cleanCricHeroesName(rawName.replace(/\b\w/g, function(c) { return c.toUpperCase(); }));
    if (!seen[profileId] && name) {
      seen[profileId] = true;
      players.push({ name: name, profileId: profileId });
    }
  }

  // Also extract "Yet to Bat" players
  var yetToBatRegex = /Yet to Bat[:\s]*([\s\S]*?)(?:Fall Of Wickets|$)/gi;
  var ytbMatch;
  while ((ytbMatch = yetToBatRegex.exec(html)) !== null) {
    var names = ytbMatch[1].split(',');
    for (var i = 0; i < names.length; i++) {
      var n = names[i].trim();
      if (n && n.length > 1 && n.length < 50) {
        var nLower = n.toLowerCase();
        var alreadyFound = players.some(function(p) { return p.name.toLowerCase() === nLower; });
        if (!alreadyFound) players.push({ name: n, profileId: '' });
      }
    }
  }

  return { players: players, source: 'html', htmlLength: html.length };
}

// --- Purge integration-test data (admin API — called by npm test / npm run test:cleanup) ---

function requireAdminToken(body) {
  var bypass = getAdminBypassToken();
  var token = (body.writeToken || body.token || '').toString().trim();
  if (!bypass || token !== bypass) return 'Admin access required';
  return null;
}

function isTestPayTo(payTo) {
  var s = (payTo || '').toString().trim();
  if (!s) return false;
  var testPayTos = {
    'Admin': true, 'Player2': true, 'AutoAdmin': true, 'DupTest': true,
    'RenameAdmin': true, 'DelAdmin': true, 'UnmarkAdmin': true, 'Collector': true,
    'RoundAdmin': true, 'BatchAdmin': true, 'ExactAdmin': true, 'OwnerA': true,
    'OwnerB': true, 'TokenTest': true, 'Test': true, 'X': true, 'BypassTest': true
  };
  if (testPayTos[s]) return true;
  if (s.charAt(0) === '=') return true;
  if (s.charAt(0) === "'" && s.length > 1 && s.charAt(1) === '=') return true;
  return false;
}

function isTestPlayerName(name) {
  var n = (name || '').toString().trim();
  if (!n) return false;
  var prefixes = [
    'Player1', 'Player2', 'Player3', 'Player4', 'Player5',
    'TempPlayer', 'Solo', 'Early1', 'Early2', 'LatePlayer',
    'AutoAdmin', 'DupTest', 'PlayerDup', 'BatchA', 'BatchB',
    'BatchPlayer', 'Admin', 'TokenTest', 'ExactAdmin',
    'RenameMe', 'RenamedPlayer', 'RenameAdmin',
    'DeleteMe', 'DelAdmin', 'UnmarkAdmin', 'UnmarkPlayer',
    'OwnerA', 'OwnerB', 'Collector', 'RoundAdmin', 'RoundA', 'RoundB',
    'BatchAdmin', 'Alice', 'Bob', 'Carol', 'Test', 'TestPreReg', 'P1',
    'A', 'B', 'C', 'D'
  ];
  for (var i = 0; i < prefixes.length; i++) {
    var pre = prefixes[i];
    if (n === pre || n.indexOf(pre + ' ') === 0) return true;
  }
  return false;
}

function playerHasPaymentHistory(playerId, playerNameLower, paymentData) {
  for (var j = 1; j < paymentData.length; j++) {
    var payPid = (paymentData[j][2] || '').toString();
    if (payPid && payPid === playerId) return true;
    if (playerNameLower && !payPid &&
        paymentData[j][1].toString().toLowerCase() === playerNameLower) return true;
  }
  return false;
}

function purgeTestData(body) {
  var adminErr = requireAdminToken(body);
  if (adminErr) return { error: adminErr };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var matchSheet = getSheetCached('Matches');
    var matchData = getSheetData('Matches');
    var idsToDelete = {};
    var keptMatches = [];
    var matchesDeleted = 0;

    for (var i = matchData.length - 1; i >= 1; i--) {
      var row = matchData[i];
      if (isTestPayTo(row[6])) {
        idsToDelete[row[0]] = true;
        matchSheet.deleteRow(i + 1);
        matchesDeleted++;
      } else {
        keptMatches.push({
          matchId: row[0],
          date: formatDateStr(row[1]),
          payTo: row[6]
        });
      }
    }
    invalidateSheetData('Matches');

    var paymentsDeleted = 0;
    if (matchesDeleted > 0) {
      var paymentSheet = getSheetCached('Payments');
      var paymentData = getSheetData('Payments');
      for (var p = paymentData.length - 1; p >= 1; p--) {
        if (idsToDelete[paymentData[p][0]]) {
          paymentSheet.deleteRow(p + 1);
          paymentsDeleted++;
        }
      }
      invalidateSheetData('Payments');
    }

    var playersDeleted = 0;
    var playerSheet = getSheetCached('Players');
    var playerData = getSheetData('Players');
    var paymentData2 = getSheetData('Payments');
    for (var m = playerData.length - 1; m >= 1; m--) {
      var playerId = playerData[m][0].toString();
      var playerName = playerData[m][1].toString();
      if (!isTestPlayerName(playerName)) continue;
      var nameLower = playerName.toLowerCase();
      if (playerHasPaymentHistory(playerId, nameLower, paymentData2)) continue;
      playerSheet.deleteRow(m + 1);
      playersDeleted++;
    }
    if (playersDeleted > 0) invalidateSheetData('Players');

    return {
      success: true,
      matchesDeleted: matchesDeleted,
      paymentsDeleted: paymentsDeleted,
      playersDeleted: playersDeleted,
      keptMatches: keptMatches
    };
  } finally {
    lock.releaseLock();
  }
}

// --- Data Reset Helper (run once from Apps Script editor to wipe test data) ---

function resetAllData() {
  var ss = getSpreadsheet();
  ['Matches', 'Payments', 'Players'].forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1); // keep header row, delete everything else
    }
    Logger.log('Cleared ' + name + ' (' + (lastRow - 1) + ' data rows deleted)');
  });
  Logger.log('✅ All test data cleared. Sheets are empty and ready for real use.');
}

// --- Delete matches by date (run from Apps Script editor) ---
// Usage: change the date string below, then Run this function.
// Deletes ALL matches on that date and their payment rows.

function deleteMatchesByDate() {
  var DATE_TO_DELETE = '2026-06-08'; // ← change this date, then click Run

  var ss = getSpreadsheet();
  var matchSheet = ss.getSheetByName('Matches');
  var paymentSheet = ss.getSheetByName('Payments');

  var matchData = matchSheet.getDataRange().getValues();
  var idsToDelete = [];

  for (var i = matchData.length - 1; i >= 1; i--) {
    var rowDate = formatDateStr(matchData[i][1]);
    if (rowDate === DATE_TO_DELETE) {
      idsToDelete.push(matchData[i][0]);
      matchSheet.deleteRow(i + 1);
      Logger.log('Deleted match row: ' + matchData[i][0] + ' (' + rowDate + ')');
    }
  }

  if (idsToDelete.length === 0) {
    Logger.log('No matches found for date: ' + DATE_TO_DELETE);
    return;
  }

  // Delete payment rows for those match IDs
  var paymentData = paymentSheet.getDataRange().getValues();
  for (var j = paymentData.length - 1; j >= 1; j--) {
    if (idsToDelete.indexOf(paymentData[j][0]) !== -1) {
      paymentSheet.deleteRow(j + 1);
    }
  }

  Logger.log('✅ Deleted ' + idsToDelete.length + ' match(es) for ' + DATE_TO_DELETE + ' and all their payment rows.');
}

// --- Delete a single match by ID (run from Apps Script editor) ---
// Usage: set MATCH_ID below to the ID shown in the app URL, then Run.

function deleteMatchById() {
  var MATCH_ID = 'PASTE_MATCH_ID_HERE'; // ← paste the matchId, then click Run

  var ss = getSpreadsheet();
  var matchSheet = ss.getSheetByName('Matches');
  var paymentSheet = ss.getSheetByName('Payments');

  var matchData = matchSheet.getDataRange().getValues();
  var deleted = false;
  for (var i = matchData.length - 1; i >= 1; i--) {
    if (matchData[i][0] === MATCH_ID) {
      matchSheet.deleteRow(i + 1);
      deleted = true;
      break;
    }
  }

  if (!deleted) {
    Logger.log('Match not found: ' + MATCH_ID);
    return;
  }

  var paymentData = paymentSheet.getDataRange().getValues();
  var pDeleted = 0;
  for (var j = paymentData.length - 1; j >= 1; j--) {
    if (paymentData[j][0] === MATCH_ID) {
      paymentSheet.deleteRow(j + 1);
      pDeleted++;
    }
  }

  Logger.log('✅ Deleted match ' + MATCH_ID + ' and ' + pDeleted + ' payment row(s).');
}

// --- Sheet Initialization Helper ---

function initializeSheets() {
  var ss = getSpreadsheet();

  function ensureSheet(name, headers) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    // Insert header row if sheet is empty OR first cell doesn't match expected header
    var firstCell = sheet.getLastRow() > 0 ? sheet.getRange(1, 1).getValue().toString() : '';
    if (firstCell !== headers[0]) {
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      Logger.log('Added headers to: ' + name);
    } else {
      Logger.log('Headers already present in: ' + name);
    }
    return sheet;
  }

  var matchesSheet = ensureSheet('Matches',  ['MatchID', 'Date', 'CricHeroesURL', 'TotalCost', 'PerPlayerCost', 'PlayerCount', 'PayTo', 'PayToUPI', 'Status', 'WriteToken', 'SplitMode']);
  if (matchesSheet.getLastColumn() < 11 || matchesSheet.getRange(1, 11).getValue().toString() !== 'SplitMode') {
    matchesSheet.getRange(1, 11).setValue('SplitMode');
    Logger.log('Added SplitMode column header to Matches');
  }
  ensureSheet('Payments', ['MatchID', 'PlayerName', 'PlayerID', 'AmountOwed', 'Paid', 'PaidTimestamp']);
  ensureSheet('Players',  ['PlayerID', 'Name', 'CricHeroesProfileID']);

  Logger.log('Sheets initialized!');
}

/**
 * One-shot migration: write a token into any Matches row with an empty WriteToken (col J).
 * Run from the Apps Script editor BEFORE deploying strict validateWriteToken.
 * Admins must re-share admin links (?w=) for backfilled matches.
 */
function backfillWriteTokens() {
  var sheet = getSheet('Matches');
  var data = sheet.getDataRange().getValues();
  var filled = 0;

  for (var i = 1; i < data.length; i++) {
    var existing = (data[i][9] || '').toString().trim();
    if (existing) continue;
    var token = generateWriteToken();
    sheet.getRange(i + 1, 10).setValue(token);
    filled++;
    Logger.log('Backfilled token for match ' + data[i][0]);
  }

  Logger.log('backfillWriteTokens: filled ' + filled + ' row(s). Re-share admin ?w= links for those matches.');
  return { filled: filled };
}

/**
 * One-shot migration: Create Players sheet entries for any player in Payments who doesn't have one yet.
 * Run from the Apps Script editor to backfill existing players.
 */
function backfillPlayerIds() {
  var ss = getSpreadsheet();
  var playersSheet = ss.getSheetByName('Players');
  var paymentsSheet = ss.getSheetByName('Payments');
  
  if (!playersSheet || !paymentsSheet) {
    Logger.log('Players or Payments sheet not found');
    return { error: 'Sheets not found' };
  }
  
  var playersData = playersSheet.getDataRange().getValues();
  var paymentsData = paymentsSheet.getDataRange().getValues();
  
  // Build map of existing players by name
  var existingPlayers = {};
  for (var i = 1; i < playersData.length; i++) {
    var name = (playersData[i][1] || '').toString();
    if (name) existingPlayers[name.toLowerCase()] = playersData[i][0].toString();
  }
  
  // Find unique player names from Payments who don't have Players entries
  var missingPlayers = {};
  for (var j = 1; j < paymentsData.length; j++) {
    var name = (paymentsData[j][1] || '').toString();
    if (!name) continue;
    var nameLower = name.toLowerCase();
    if (!existingPlayers[nameLower] && !missingPlayers[nameLower]) {
      missingPlayers[nameLower] = name;
    }
  }
  
  // Create Players entries for missing players
  var created = 0;
  var playerIdMap = {}; // nameLower -> playerId
  for (var key in missingPlayers) {
    var playerName = missingPlayers[key];
    var playerId = generateId();
    playersSheet.appendRow([playerId, playerName, '']);
    playerIdMap[key] = playerId;
    created++;
    Logger.log('Created player: ' + playerName + ' -> ' + playerId);
  }
  
  // Update Payments rows to reference the new PlayerIDs
  var updated = 0;
  for (var k = 1; k < paymentsData.length; k++) {
    var pName = (paymentsData[k][1] || '').toString();
    if (!pName) continue;
    var pNameLower = pName.toLowerCase();
    var existingPid = (paymentsData[k][2] || '').toString();
    
    if (!existingPid) {
      // Find the playerId (either from existing or newly created)
      var pid = existingPlayers[pNameLower] || playerIdMap[pNameLower];
      if (pid) {
        paymentsSheet.getRange(k + 1, 3).setValue(pid);
        updated++;
      }
    }
  }
  
  invalidateSheetData('Players');
  invalidateSheetData('Payments');
  
  Logger.log('✅ Created ' + created + ' player(s), updated ' + updated + ' payment row(s)');
  return { created: created, updated: updated };
}
