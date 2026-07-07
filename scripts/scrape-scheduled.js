// scrape-scheduled.js
//
// Pulls forward-looking "next step" dates for in-progress sequence
// enrollments, since HubSpot has no API for this. Verified against a real,
// logged-in HubSpot session on 2026-07-07 -- selectors are positional
// (HubSpot's CSS classes are auto-generated hashes with no stable names),
// matched by column order and parsed via regex on cell text.
//
// Requires env vars: HUBSPOT_SESSION_COOKIES (JSON array), HUBSPOT_PORTAL_ID
// Writes: ../data/scheduled.json

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIES_JSON = process.env.HUBSPOT_SESSION_COOKIES;
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const MAX_SEQUENCES = parseInt(process.env.MAX_SEQUENCES || '150', 10);

if (!COOKIES_JSON || !PORTAL_ID) {
  console.error('Missing HUBSPOT_SESSION_COOKIES or HUBSPOT_PORTAL_ID environment variable.');
  process.exit(1);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function getAllSequenceIds(page) {
  const ids = [];
  let pageNum = 1;
  while (true) {
    await page.goto(
      `https://app.hubspot.com/sequences/${PORTAL_ID}/manage?field=updated_at&order=DESC&page=${pageNum}`,
      { waitUntil: 'networkidle' }
    );
    const links = await page.$$eval('a[href*="/sequence/"]', as =>
      as.map(a => {
        const m = a.getAttribute('href').match(/\/sequence\/(\d+)/);
        return m ? m[1] : null;
      }).filter(Boolean)
    );
    if (links.length === 0) break;
    ids.push(...links);
    pageNum++;
    if (ids.length >= MAX_SEQUENCES || pageNum > 50) break;
    await sleep(300);
  }
  return [...new Set(ids)].slice(0, MAX_SEQUENCES);
}

async function scrapeSequenceEnrollments(page, sequenceId) {
  const url = `https://app.hubspot.com/sequences/${PORTAL_ID}/sequence/${sequenceId}/enrollments/in-progress?enrolledBy=ALL_USERS`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await sleep(800);

  const rows = [];
  let pageNum = 1;
  while (true) {
    const rowData = await page.$$eval('table tbody tr', trs =>
      trs.map(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 8) return null;
        const enrolledText = cells[3].textContent.trim();
        const detailsText = cells[7].textContent.trim();
        const ownerMatch = enrolledText.match(/by (.+)$/);
        const nextStepMatch = detailsText.match(/next step on (.+)$/i);
        if (!ownerMatch || !nextStepMatch) return null;
        return { repName: ownerMatch[1].trim(), nextStepText: nextStepMatch[1].trim() };
      }).filter(Boolean)
    );
    rows.push(...rowData);

    const nextBtn = await page.$('button[aria-label="Next"], a[aria-label="Next"]');
    if (!nextBtn) break;
    const isDisabled = await nextBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
    if (isDisabled) break;
    await nextBtn.click();
    await sleep(700);
    pageNum++;
    if (pageNum > 200) break; // safety valve
  }
  return rows;
}

async function main() {
  const rawCookies = JSON.parse(COOKIES_JSON);

  // Cookie-Editor's export format doesn't exactly match what Playwright
  // expects (different sameSite naming, different expiry field name).
  // Normalize each cookie here.
  const cookies = rawCookies.map(c => {
    let sameSite = 'Lax';
    const s = (c.sameSite || '').toLowerCase();
    if (s === 'no_restriction' || s === 'none') sameSite = 'None';
    else if (s === 'strict') sameSite = 'Strict';

    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined,
      httpOnly: !!c.httpOnly,
      // Chrome requires secure:true whenever sameSite is 'None'
      secure: sameSite === 'None' ? true : !!c.secure,
      sameSite
    };
  });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();

  console.log('Checking session...');
  await page.goto(`https://app.hubspot.com/sequences/${PORTAL_ID}/manage`, { waitUntil: 'networkidle' });
  const bodyText = await page.textContent('body');
  if (bodyText.includes('Sign in') || bodyText.includes('Log in')) {
    throw new Error('Session cookie appears expired -- re-export it from your browser.');
  }

  console.log('Listing sequences...');
  const sequenceIds = await getAllSequenceIds(page);
  console.log(`Found ${sequenceIds.length} sequences to check.`);

  const allRows = [];
  for (let i = 0; i < sequenceIds.length; i++) {
    const id = sequenceIds[i];
    try {
      console.log(`[${i + 1}/${sequenceIds.length}] Checking sequence ${id}...`);
      const rows = await scrapeSequenceEnrollments(page, id);
      if (rows.length > 0) console.log(`  -> ${rows.length} in-progress enrollments`);
      allRows.push(...rows);
    } catch (err) {
      console.log(`  -> skipped (${err.message})`);
    }
    await sleep(400);
  }

  const parsedRows = allRows.map(r => {
    const d = new Date(r.nextStepText);
    return {
      repName: r.repName,
      sendDate: isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
    };
  }).filter(r => r.sendDate);

  console.log(`Total scheduled rows: ${parsedRows.length}`);
  await browser.close();

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'scraped-ui',
    rows: parsedRows
  };

  const outPath = path.join(__dirname, '..', 'data', 'scheduled.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
