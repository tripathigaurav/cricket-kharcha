// ============================================================
// Cricket Kharcha — Configuration Template
// ============================================================
// 1. Copy this file to config.js
// 2. Replace the placeholder values below with your own
// 3. config.js is gitignored — your credentials stay local
// ============================================================

const CRICKET_API_URL = 'YOUR_APPS_SCRIPT_DEPLOYMENT_URL';
const CRICKET_SHEET_ID = 'YOUR_GOOGLE_SHEET_ID';

// Allow Node.js test runner to require() this file
if (typeof module !== 'undefined') {
  module.exports = { CRICKET_API_URL, CRICKET_SHEET_ID };
}
