// scrape-scheduled.js
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

async function goAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1500);
}

async function getAllSequenceIds(page) {
  const ids = [];
  let pageNum = 1;
  while (true) {
    await goAndSettle(page, `https://app.hubspot.com/sequences/${PORTAL_ID}/manage?field=updated_at&order=DESC&page=${pageNum}`);
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
  await goAndSettle(page, url);

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

    const nextBtn = await page.$('button[aria-label="Next page"], a[aria-label="Next page"]');
    if (!nextBtn) break;
    const isDisabled = await nextBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
    if (isDisabled) break;
    await nextBtn.click();
    await sleep(900);
    pageNum++;
    if (pageNum > 200) break;
  }
  return rows;
}

async function main() {
  const rawCookies = JSON.parse(COOKIES_JSON);

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
      secure: sameSite === 'None' ? true : !!c.secure,
      sameSite
    };
  });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();

  console.log('Checking session...');
  await goAndSettle(page, `https://app.hubspot.com/sequences/${PORTAL_ID}/manage`);
  const currentUrl = page.url();
  console.log('Landed on:', currentUrl);
  if (currentUrl.includes('/login')) {
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
