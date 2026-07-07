// scrape-scheduled.js
//
// Pulls the "Scheduled" sequence-send view from HubSpot's own UI, since
// this data has no public API. Uses a saved, already-authenticated session
// (cookies) rather than automating your login form — this deliberately
// avoids scripting past 2FA or bot-detection on the login page itself.
//
// ============================== IMPORTANT ==============================
// This script is a STARTING TEMPLATE, not a verified, tested scraper.
// I do not have a live HubSpot login to inspect the actual page structure
// of the Sequences > Scheduled view, so the selectors below are best-effort
// guesses based on common HubSpot UI patterns. You (or a follow-up session
// using Claude in Chrome against your real, logged-in account) will very
// likely need to open the Scheduled page, inspect the actual DOM, and
// correct the selectors marked TODO below before this reliably works.
// =========================================================================
//
// How to get the session cookie (do this yourself, don't share it with anyone):
//   1. Log into HubSpot normally in Chrome.
//   2. Open DevTools > Application > Cookies > https://app.hubspot.com
//   3. Export the full cookie list as JSON (there are browser extensions
//      for this, e.g. "Cookie-Editor" — use one you trust, or copy manually).
//   4. Store that JSON as a GitHub Secret named HUBSPOT_SESSION_COOKIES.
//   5. Repeat periodically when the session expires (HubSpot session
//      cookies are typically valid for a few weeks).
//
// Requires env var: HUBSPOT_SESSION_COOKIES (JSON array of cookie objects)
// Requires env var: HUBSPOT_PORTAL_ID (your numeric HubSpot account ID)
// Writes: ../data/scheduled.json

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIES_JSON = process.env.HUBSPOT_SESSION_COOKIES;
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;

if (!COOKIES_JSON || !PORTAL_ID) {
  console.error('Missing HUBSPOT_SESSION_COOKIES or HUBSPOT_PORTAL_ID environment variable.');
  process.exit(1);
}

async function main() {
  const cookies = JSON.parse(COOKIES_JSON);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();

  const scheduledUrl = `https://app.hubspot.com/sequences/${PORTAL_ID}/scheduled`;
  console.log(`Navigating to ${scheduledUrl}...`);
  await page.goto(scheduledUrl, { waitUntil: 'networkidle' });

  // TODO: verify this actually landed on the Scheduled tab and not a login
  // redirect (cookie expired). A simple check: look for a known element
  // that only exists when logged in.
  const loggedIn = await page.locator('body').innerText().then(t => !t.includes('Log in'));
  if (!loggedIn) {
    throw new Error('Session cookie appears to be expired — re-export it from your browser.');
  }

  // TODO: HubSpot's Scheduled tab may have its own "Export" button rather
  // than a plain table. If so, prefer clicking that and reading the
  // downloaded file over scraping DOM rows directly — it will be far more
  // reliable. Example pattern (adjust selector):
  //
  // const [download] = await Promise.all([
  //   page.waitForEvent('download'),
  //   page.click('button:has-text("Export")')
  // ]);
  // const downloadPath = await download.path();
  // ... then parse the downloaded CSV instead of the DOM scrape below.

  // Best-effort DOM scrape fallback if no export button is found:
  const rows = await page.locator('[data-test-id="scheduled-email-row"]').all(); // TODO: real selector
  const scheduled = [];
  for (const row of rows) {
    const repName = await row.locator('[data-test-id="row-owner"]').innerText().catch(() => null); // TODO
    const sendDate = await row.locator('[data-test-id="row-next-send"]').innerText().catch(() => null); // TODO
    if (repName && sendDate) {
      scheduled.push({ repName: repName.trim(), sendDate: sendDate.trim() });
    }
  }

  console.log(`Scraped ${scheduled.length} scheduled-send rows.`);
  await browser.close();

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'scraped-ui',
    rows: scheduled
  };

  const outPath = path.join(__dirname, '..', 'data', 'scheduled.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);

  if (scheduled.length === 0) {
    console.warn('WARNING: 0 rows scraped. The selectors in this script almost certainly need updating — see TODOs at the top of scrape-scheduled.js.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
