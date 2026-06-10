// ============================================================
// CricTracker — Configuration Template
// ============================================================
// 1. Copy this file to config.js
// 2. Replace the placeholder values below with your own
// 3. config.js is gitignored — your credentials stay local
// ============================================================

const CRICKET_API_URL = 'YOUR_APPS_SCRIPT_DEPLOYMENT_URL';
// Optional: separate test deployment (recommended for npm test)
const CRICKET_TEST_API_URL = '';
// Admin bypass token — for npm test cleanup and: npm run test:cleanup
const CRICKET_ADMIN_TOKEN = '';
// Sheet ID is server-side only (set in Code.gs EDITOR_SHEET_ID or Script Properties).
// Kept here only for the Node.js test runner — never shipped to browsers.
const CRICKET_SHEET_ID = 'YOUR_GOOGLE_SHEET_ID';

// Allow Node.js test runner to require() this file
if (typeof module !== 'undefined') {
  module.exports = { CRICKET_API_URL, CRICKET_TEST_API_URL, CRICKET_ADMIN_TOKEN, CRICKET_SHEET_ID };
}
