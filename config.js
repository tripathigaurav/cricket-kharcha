// ============================================================
// Cricket Kharcha — Configuration
// ============================================================
// To self-host: copy config.example.js → config.js and
// fill in your own Apps Script URL and Sheet ID.
// ============================================================

const CRICKET_API_URL = 'https://script.google.com/macros/s/AKfycbyKXOQOsxEcwMQzLagw_VdG1iueTdnqa2JMqcrWzSe8c8kN69iR541FVKmEiyepli3f1w/exec';
const CRICKET_SHEET_ID = '1-fc2qeYArJ7i5KmmT5xzytUdMOCzFGIayrYrezXZ3qE';

// Allow Node.js test runner to require() this file
if (typeof module !== 'undefined') {
  module.exports = { CRICKET_API_URL, CRICKET_SHEET_ID };
}
