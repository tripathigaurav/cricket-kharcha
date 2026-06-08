// ============================================================
// Cricket Payment Tracker — Google Apps Script Backend
// ============================================================
// Deploy as Web App: Execute as "Me", Access "Anyone"
//
// SETUP:
// 1. Create a Google Sheet
// 2. Add 3 tabs: "Matches", "Payments", "Players"
// 3. Open Extensions > Apps Script, paste this code
// 4. Set SHEET_ID below to your spreadsheet ID
// 5. Deploy > New Deployment > Web App > Anyone
// 6. Copy the deployment URL into app.js API_URL
// ============================================================

const SHEET_ID = '1-fc2qeYArJ7i5KmmT5xzytUdMOCzFGIayrYrezXZ3qE';
const MAX_NAME_LEN = 100;
const MAX_FIELD_LEN = 200;

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
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
}

// --- Web App Entry Points ---

function doGet(e) {
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
      case 'removePlayer':
        result = removePlayer(body);
        break;
      case 'lockMatch':
        result = lockMatch(body);
        break;
      case 'markPaid':
        result = markPaid(body);
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
  const date = sanitize(body.date || new Date().toISOString().split('T')[0], 20);
  const payTo = sanitize(body.payTo, MAX_FIELD_LEN);
  const payToUPI = sanitize(body.payToUPI, MAX_FIELD_LEN);
  if (!payTo) return { error: 'payTo is required' };

  // Columns: MatchID | Date | CricHeroesURL | TotalCost | PerPlayerCost | PlayerCount | PayTo | PayToUPI | Status
  sheet.appendRow([matchId, date, '', 0, 0, 0, payTo, payToUPI, 'checkin']);
  SpreadsheetApp.flush();

  return { success: true, matchId: matchId };
}

function getMatches() {
  const matchSheet = getSheet('Matches');
  const matchData = matchSheet.getDataRange().getValues();
  const paymentSheet = getSheet('Payments');
  const paymentData = paymentSheet.getDataRange().getValues();

  if (matchData.length <= 1) return { matches: [] };

  const matches = [];
  for (let i = 1; i < matchData.length; i++) {
    const row = matchData[i];
    const matchId = row[0];
    const totalCost = Number(row[3]) || 0;

    // Count players and paid
    let playerCount = 0;
    let paidCount = 0;
    let paidAmount = 0;
    for (let j = 1; j < paymentData.length; j++) {
      if (paymentData[j][0] === matchId) {
        playerCount++;
        if (paymentData[j][4] === true || paymentData[j][4] === 'TRUE') {
          paidCount++;
          paidAmount += Number(paymentData[j][3]) || 0;
        }
      }
    }

    matches.push({
      matchId: matchId,
      date: formatDateStr(row[1]),
      cricheroes: row[2],
      totalCost: totalCost,
      perPlayerCost: Number(row[4]) || 0,
      playerCount: playerCount,
      payTo: row[6],
      payToUPI: row[7],
      status: row[8],
      paidCount: paidCount,
      paidAmount: paidAmount
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

  const matchSheet = getSheet('Matches');
  const matchData = matchSheet.getDataRange().getValues();

  let match = null;
  for (let i = 1; i < matchData.length; i++) {
    if (matchData[i][0] === matchId) {
    match = {
        matchId: matchData[i][0],
        date: formatDateStr(matchData[i][1]),
        cricheroes: matchData[i][2],
        totalCost: Number(matchData[i][3]) || 0,
        perPlayerCost: Number(matchData[i][4]) || 0,
        playerCount: Number(matchData[i][5]) || 0,
        payTo: matchData[i][6],
        payToUPI: matchData[i][7],
        status: matchData[i][8]
      };
      break;
    }
  }

  if (!match) return { error: 'Match not found' };

  // Get players for this match
  const paymentSheet = getSheet('Payments');
  const paymentData = paymentSheet.getDataRange().getValues();
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
  match.paidCount = players.filter(function(p) { return p.paid; }).length;
  match.paidAmount = players.filter(function(p) { return p.paid; }).reduce(function(s, p) { return s + p.amountOwed; }, 0);

  return { match: match };
}

// --- Check-in ---

function checkIn(body) {
  const matchId = body.matchId;
  const playerName = sanitize(body.playerName, MAX_NAME_LEN);

  if (!matchId || !playerName) return { error: 'Missing matchId or playerName' };

  // Use script lock to prevent concurrent duplicate check-ins (race condition fix)
  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    // Verify match exists and read current perPlayerCost
    const matchSheet = getSheet('Matches');
    const matchData = matchSheet.getDataRange().getValues();
    let matchRow = -1;
    let currentPerPlayerCost = 0;
    for (let i = 1; i < matchData.length; i++) {
      if (matchData[i][0] === matchId) {
        matchRow = i + 1;
        currentPerPlayerCost = Number(matchData[i][4]) || 0; // col E = PerPlayerCost
        break;
      }
    }
    if (matchRow === -1) return { error: 'Match not found' };

    // Check for duplicate (case-insensitive)
    const paymentSheet = getSheet('Payments');
    const paymentData = paymentSheet.getDataRange().getValues();
    for (let j = 1; j < paymentData.length; j++) {
      if (paymentData[j][0] === matchId && paymentData[j][1].toString().toLowerCase() === playerName.toLowerCase()) {
        return { error: 'Player already checked in' };
      }
    }

    // Find or create player in master roster
    const playerId = getOrCreatePlayer(playerName);

    // If match already has a per-player cost, apply it immediately so new player sees correct amount
    const amountOwed = currentPerPlayerCost > 0 ? currentPerPlayerCost : 0;

    // Columns: MatchID | PlayerName | PlayerID | AmountOwed | Paid | PaidTimestamp
    paymentSheet.appendRow([matchId, playerName, playerId, amountOwed, false, '']);
    SpreadsheetApp.flush();

    return { success: true, playerName: playerName };
  } finally {
    lock.releaseLock();
  }
}

function getOrCreatePlayer(name) {
  const sheet = getSheet('Players');
  const data = sheet.getDataRange().getValues();
  const nameLower = name.toLowerCase();

  for (let i = 1; i < data.length; i++) {
    if (data[i][1].toString().toLowerCase() === nameLower) {
      return data[i][0]; // return existing PlayerID
    }
  }

  // Create new player
  const playerId = generateId();
  // Columns: PlayerID | Name | CricHeroesProfileID
  sheet.appendRow([playerId, name, '']);
  return playerId;
}

// --- Remove Player ---

function removePlayer(body) {
  const matchId = body.matchId;
  const playerName = (body.playerName || '').trim();

  if (!matchId || !playerName) return { error: 'Missing matchId or playerName' };

  const paymentSheet = getSheet('Payments');
  const paymentData = paymentSheet.getDataRange().getValues();

  for (let j = paymentData.length - 1; j >= 1; j--) {
    if (paymentData[j][0] === matchId && paymentData[j][1].toString().toLowerCase() === playerName.toLowerCase()) {
      paymentSheet.deleteRow(j + 1);
      return { success: true };
    }
  }

  return { error: 'Player not found in this match' };
}

// --- Lock Match ---

function lockMatch(body) {
  const matchId = body.matchId;
  const totalCost = Number(body.totalCost);

  if (!matchId || !totalCost || totalCost <= 0) return { error: 'Missing matchId or invalid totalCost' };

  const matchSheet = getSheet('Matches');
  const matchData = matchSheet.getDataRange().getValues();
  let matchRow = -1;

  for (let i = 1; i < matchData.length; i++) {
    if (matchData[i][0] === matchId) {
      matchRow = i + 1;
      break;
    }
  }
  if (matchRow === -1) return { error: 'Match not found' };

  // Count players
  const paymentSheet = getSheet('Payments');
  const paymentData = paymentSheet.getDataRange().getValues();
  const playerRows = [];
  for (let j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId) {
      playerRows.push(j + 1); // 1-indexed sheet row
    }
  }

  if (playerRows.length === 0) return { error: 'No players checked in' };

  const perPlayerCost = Math.ceil(totalCost / playerRows.length);

  // Update match row: TotalCost, PerPlayerCost, PlayerCount (no status change — players can always be added)
  matchSheet.getRange(matchRow, 4).setValue(totalCost);         // TotalCost (col D)
  matchSheet.getRange(matchRow, 5).setValue(perPlayerCost);     // PerPlayerCost (col E)
  matchSheet.getRange(matchRow, 6).setValue(playerRows.length); // PlayerCount (col F)
  SpreadsheetApp.flush();

  // Update each player's AmountOwed
  for (let k = 0; k < playerRows.length; k++) {
    paymentSheet.getRange(playerRows[k], 4).setValue(perPlayerCost); // AmountOwed (col D)
  }

  return { success: true, perPlayerCost: perPlayerCost, playerCount: playerRows.length };
}

// --- Mark Paid ---

function markPaid(body) {
  const matchId = body.matchId;
  const playerName = (body.playerName || '').trim();
  const paid = body.paid !== false; // default to true

  if (!matchId || !playerName) return { error: 'Missing matchId or playerName' };

  const paymentSheet = getSheet('Payments');
  const paymentData = paymentSheet.getDataRange().getValues();

  for (let j = 1; j < paymentData.length; j++) {
    if (paymentData[j][0] === matchId && paymentData[j][1].toString().toLowerCase() === playerName.toLowerCase()) {
      const row = j + 1;
      paymentSheet.getRange(row, 5).setValue(paid);  // Paid (col E)
      paymentSheet.getRange(row, 6).setValue(paid ? new Date().toISOString() : ''); // PaidTimestamp (col F)
      return { success: true, paid: paid };
    }
  }

  return { error: 'Player not found in this match' };
}

// --- Player Stats ---

function getPlayers() {
  const paymentSheet = getSheet('Payments');
  const paymentData = paymentSheet.getDataRange().getValues();

  const stats = {};

  for (let j = 1; j < paymentData.length; j++) {
    const name = paymentData[j][1].toString();
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
  var ss = SpreadsheetApp.openById(SHEET_ID);
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

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var matchSheet = ss.getSheetByName('Matches');
  var paymentSheet = ss.getSheetByName('Payments');

  var matchData = matchSheet.getDataRange().getValues();
  var idsToDelete = [];

  // Collect matching match IDs (scan bottom-up so row deletion doesn't shift indices)
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

  var ss = SpreadsheetApp.openById(SHEET_ID);
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
  var ss = SpreadsheetApp.openById(SHEET_ID);

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

  ensureSheet('Matches',  ['MatchID', 'Date', 'CricHeroesURL', 'TotalCost', 'PerPlayerCost', 'PlayerCount', 'PayTo', 'PayToUPI', 'Status']);
  ensureSheet('Payments', ['MatchID', 'PlayerName', 'PlayerID', 'AmountOwed', 'Paid', 'PaidTimestamp']);
  ensureSheet('Players',  ['PlayerID', 'Name', 'CricHeroesProfileID']);

  Logger.log('Sheets initialized!');
}
