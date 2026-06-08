// ============================================================
// CricTracker — Google Apps Script Backend
// ============================================================
// Deploy as Web App: Execute as "Me", Access "Anyone"
//
// SETUP:
// 1. Create a Google Sheet
// 2. Add 3 tabs: "Matches", "Payments", "Players"
// 3. Open Extensions > Apps Script, paste this code
// 4. Run setSheetId('YOUR_SHEET_ID') once in the editor (stores in Script Properties — do not commit ID to git)
//    FALLBACK_SHEET_ID in this file stays empty in the public repo.
// 5. Set project timezone: File > Project properties > Asia/Kolkata
// 6. Deploy > New Deployment > Web App > Anyone
// 7. Copy the deployment URL into config.js
// ============================================================

const MAX_NAME_LEN = 100;
const MAX_FIELD_LEN = 200;
const WRITE_TOKEN_LEN = 16;

// Leave empty in git. Optional local-only fallback if you paste Code.gs without running setSheetId().
const FALLBACK_SHEET_ID = '';

function getSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  // Container-bound script: opened via Extensions > Apps Script on the sheet
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    id = active.getId();
    props.setProperty('SHEET_ID', id);
    return active;
  }

  // Editor / web-app fallback — set FALLBACK_SHEET_ID at top of this file
  if (FALLBACK_SHEET_ID) {
    props.setProperty('SHEET_ID', FALLBACK_SHEET_ID);
    return SpreadsheetApp.openById(FALLBACK_SHEET_ID);
  }

  throw new Error(
    'SHEET_ID not set. Run setSheetId("your-sheet-id") once in the Apps Script editor, ' +
    'or open this project from the sheet via Extensions > Apps Script.'
  );
}

function getSheetId() {
  return getSpreadsheet().getId();
}

/** Run once from the editor — stores Sheet ID in Script Properties (not in git). */
function setSheetId(id) {
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', String(id).trim());
}

/**
 * One-time setup helper. In the Apps Script editor only:
 * 1. Replace PASTE_YOUR_SHEET_ID with the ID from your sheet URL
 * 2. Run this function once
 * 3. Verify Project settings → Script properties shows SHEET_ID
 * Do not commit the real ID back to the public git repo.
 */
function configureSheetId() {
  setSheetId('PASTE_YOUR_SHEET_ID');
}

function generateWriteToken() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, WRITE_TOKEN_LEN);
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
        status: data[i][8]
      };
    }
  }
  return null;
}

function validateWriteToken(matchId, token) {
  var info = findMatchRow(matchId);
  if (!info) return { ok: false, error: 'Match not found' };
  var stored = (info.writeToken || '').toString().trim();
  if (!stored) return { ok: false, error: 'Write token not configured — run backfillWriteTokens() in Apps Script' };
  var provided = token ? token.toString().trim() : '';
  if (!provided || provided !== stored) return { ok: false, error: 'Invalid or missing write token' };
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
      case 'markPaid':
        result = markPaid(body);
        break;
      case 'deleteMatch':
        result = deleteMatch(body);
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
  const matchId = generateId();
  const date = sanitize(body.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'), 20);
  const payTo = sanitize(body.payTo, MAX_FIELD_LEN);
  const payToUPI = sanitize(body.payToUPI, MAX_FIELD_LEN);
  if (!payTo) return { error: 'payTo is required' };

  var writeToken = generateWriteToken();
  // Columns: MatchID | Date | CricHeroesURL | TotalCost | PerPlayerCost | PlayerCount | PayTo | PayToUPI | Status | WriteToken
  sheet.appendRow([matchId, date, '', 0, 0, 0, payTo, payToUPI, 'checkin', writeToken]);
  invalidateSheetData('Matches');

  var result = { success: true, matchId: matchId, writeToken: writeToken };
  if (body.checkInCollector && payTo) {
    var ci = checkIn({ matchId: matchId, playerName: payTo }, { noLock: true });
    if (ci.error) result.checkInError = ci.error;
    else result.checkIn = ci;
  }
  return result;
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
      paidAmount: stats.paidAmount
    });
  }

  // Sort newest first
  matches.sort(function(a, b) {
    return new Date(b.date) - new Date(a.date);
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
    requiresWriteToken: true
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
    for (let i = 1; i < matchData.length; i++) {
      if (matchData[i][0] === matchId) {
        matchRow = i + 1;
        totalCost = Number(matchData[i][3]) || 0;
        currentPerPlayerCost = Number(matchData[i][4]) || 0;
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
    const amountOwed = currentPerPlayerCost > 0 ? currentPerPlayerCost : 0;

    paymentSheet.appendRow([matchId, playerName, playerId, amountOwed, false, '']);
    invalidateSheetData('Payments');

    if (totalCost > 0) {
      var split = applySplitToMatch(matchId, matchRow, totalCost, matchSheet, paymentSheet);
      return { success: true, playerName: playerName, perPlayerCost: split.perPlayerCost, playerCount: split.playerCount, totalCost: totalCost };
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
    for (let i = 1; i < matchData.length; i++) {
      if (matchData[i][0] === matchId) {
        matchRow = i + 1;
        totalCost = Number(matchData[i][3]) || 0;
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
      paymentSheet.getRange(startRow, 1, startRow + rowsToAdd.length - 1, 6).setValues(rowsToAdd);
      invalidateSheetData('Payments');
    }

    const result = { success: true, added: added, skipped: skipped };
    if (totalCost > 0 && rowsToAdd.length > 0) {
      const split = applySplitToMatch(matchId, matchRow, totalCost, matchSheet, paymentSheet);
      result.perPlayerCost = split.perPlayerCost;
      result.playerCount = split.playerCount;
      result.totalCost = totalCost;
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
      var split = applySplitToMatch(matchId, matchInfo.sheetRow, matchInfo.totalCost, matchSheet, paymentSheet);
      return {
        success: true,
        playerName: playerName,
        perPlayerCost: split.perPlayerCost,
        playerCount: split.playerCount,
        totalCost: matchInfo.totalCost
      };
    }

    return { success: true, playerName: playerName };
  } finally {
    lock.releaseLock();
  }
}

// --- Lock Match ---

function applySplitToMatch(matchId, matchRow, totalCost, matchSheet, paymentSheet) {
  const paymentData = getSheetData('Payments');
  const playerRows = [];
  for (let j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId) {
      playerRows.push(j + 1);
    }
  }
  if (playerRows.length === 0) return { perPlayerCost: 0, playerCount: 0 };

  const perPlayerCost = Math.ceil(totalCost / playerRows.length);
  matchSheet.getRange(matchRow, 4, 1, 3).setValues([[totalCost, perPlayerCost, playerRows.length]]);
  if (playerRows.length === 1) {
    paymentSheet.getRange(playerRows[0], 4).setValue(perPlayerCost);
  } else {
    paymentSheet.getRangeList(
      playerRows.map(function(row) { return paymentSheet.getRange(row, 4).getA1Notation(); })
    ).setValue(perPlayerCost);
  }
  invalidateSheetData('Matches');
  invalidateSheetData('Payments');
  return { perPlayerCost: perPlayerCost, playerCount: playerRows.length, totalCost: totalCost };
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

    for (let i = 1; i < matchData.length; i++) {
      if (matchData[i][0] === matchId) {
        matchRow = i + 1;
        break;
      }
    }
    if (matchRow === -1) return { error: 'Match not found' };

    const paymentSheet = getSheetCached('Payments');
    const split = applySplitToMatch(matchId, matchRow, totalCost, matchSheet, paymentSheet);
    if (split.playerCount === 0) return { error: 'No players checked in' };

    return {
      success: true,
      perPlayerCost: split.perPlayerCost,
      playerCount: split.playerCount,
      totalCost: totalCost
    };
  } finally {
    lock.releaseLock();
  }
}

// --- Mark Paid ---

function markPaid(body) {
  const matchId = body.matchId;
  const playerName = sanitize(body.playerName, MAX_NAME_LEN);
  const paid = body.paid !== false; // default to true

  if (!matchId || !playerName) return { error: 'Missing matchId or playerName' };

  var tokenErr = requireWriteToken(body);
  if (tokenErr) return { error: tokenErr };

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
  const paymentData = getSheetData('Payments');

  const stats = {};

  for (let j = 1; j < paymentData.length; j++) {
    const name = paymentData[j][1].toString();
    if (!name) continue; // skip rows with blank player name
    const nameLower = name.toLowerCase();
    const amountOwed = Number(paymentData[j][3]) || 0;
    const paid = paymentData[j][4] === true || paymentData[j][4] === 'TRUE';

    if (!stats[nameLower]) {
      stats[nameLower] = { name: name, matches: 0, totalOwed: 0, totalPaid: 0 };
    }
    stats[nameLower].matches++;
    stats[nameLower].totalOwed += amountOwed;
    if (paid) {
      stats[nameLower].totalPaid += amountOwed;
    }
  }

  const players = Object.keys(stats).map(function(key) {
    var p = stats[key];
    p.outstanding = p.totalOwed - p.totalPaid;
    return p;
  });

  players.sort(function(a, b) { return b.matches - a.matches; });

  return { players: players };
}

// --- CricHeroes Scraping (Optional) ---

function scrapePlayerNames(url) {
  if (!url) return { error: 'Missing URL' };

  // Only allow CricHeroes domains — hostname check prevents SSRF bypass via path tricks
  var urlStr = url.toString();
  var allowedHost = false;
  try {
    var parsedHost = new URL(urlStr).hostname.toLowerCase();
    allowedHost = parsedHost === 'cricheroes.in' || parsedHost === 'cricheroes.com' ||
                  parsedHost.endsWith('.cricheroes.in') || parsedHost.endsWith('.cricheroes.com');
  } catch(urlErr) {
    return { players: [], note: 'Invalid URL' };
  }
  if (!allowedHost) {
    return { players: [], note: 'Only CricHeroes URLs are supported' };
  }

  // Ensure we're fetching the scorecard tab
  var scorecardUrl = url.replace(/\/summary\/?$/, '/scorecard')
                        .replace(/\/commentary\/?$/, '/scorecard')
                        .replace(/\/analysis\/?$/, '/scorecard');
  if (!/\/scorecard\/?$/.test(scorecardUrl)) {
    scorecardUrl = scorecardUrl.replace(/\/?$/, '/scorecard');
  }
  scorecardUrl = scorecardUrl.replace('cricheroes.in', 'cricheroes.com');

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

  // Fallback: scrape HTML scorecard page
  var response = UrlFetchApp.fetch(scorecardUrl, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    }
  });
  var html = response.getContentText();
  Logger.log('Scrape response length: ' + html.length + ' for URL: ' + scorecardUrl);
  // Guard against massive responses (bot detection pages, honeypots)
  if (html.length > 3000000) html = html.substring(0, 3000000);

  var players = [];
  var seen = {};

  // Extract player names from profile links: /player-profile/ID/NAME/matches
  var profileRegex = /\/player-profile\/(\d+)\/([^\/\"]+)/g;
  var match;
  while ((match = profileRegex.exec(html)) !== null) {
    var profileId = match[1];
    var rawName = decodeURIComponent(match[2]).replace(/-/g, ' ');
    var name = rawName.replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    if (!seen[profileId]) {
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

  ensureSheet('Matches',  ['MatchID', 'Date', 'CricHeroesURL', 'TotalCost', 'PerPlayerCost', 'PlayerCount', 'PayTo', 'PayToUPI', 'Status', 'WriteToken']);
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
