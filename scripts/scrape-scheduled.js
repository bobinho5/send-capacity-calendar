// scrape-scheduled.js
//
// Pulls forward-looking projected email-send dates for sequence enrollments
// that either haven't started yet ("Scheduled" status -- bulk-enrolled
// contacts HubSpot is staggering to respect daily send limits) or are
// already partway through ("In progress" status). HubSpot has no API for
// this, so it's scraped from the Sequences UI using a saved session cookie.
//
// Which sequences get checked (union of three signals, since HubSpot's
// Manage list can't be sorted by "currently active" directly):
//   1. Top MAX_SEQUENCES most recently modified
//   2. Any sequence with total-enrolled-ever above ENROLLED_THRESHOLD
//      (catches large active batches that haven't been "modified"
//      recently even though they still have a huge pending queue --
//      this is what we were missing before)
//   3. Any sequence whose name contains "inbound"
//   4. Explicitly forced IDs (FORCE_SEQUENCE_IDS)
//
// For each contact we know one certain calendar date -- either their
// enrollment's first send date (Scheduled) or their immediate next-step
// date (In progress). Combined with the sequence's Steps tab, which labels
// every step with a cumulative business-day offset (e.g. "3. Automated
// Email - Day 3"), we project every remaining email step's calendar date
// by adding the business-day difference between offsets.
//
// Requires env vars: HUBSPOT_SESSION_COOKIES (JSON array), HUBSPOT_PORTAL_ID
// Optional env vars: MAX_SEQUENCES (default 50), FORCE_SEQUENCE_IDS,
//   ENROLLED_THRESHOLD (default 200)
// Writes: ../data/scheduled.json

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIES_JSON = process.env.HUBSPOT_SESSION_COOKIES;
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const MAX_SEQUENCES = parseInt(process.env.MAX_SEQUENCES || '50', 10);
const ENROLLED_THRESHOLD = parseInt(process.env.ENROLLED_THRESHOLD || '200', 10);
const FORCE_SEQUENCE_IDS = (process.env.FORCE_SEQUENCE_IDS || '272570396,76707862')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!COOKIES_JSON || !PORTAL_ID) {
  console.error('Missing HUBSPOT_SESSION_COOKIES or HUBSPOT_PORTAL_ID environment variable.');
  process.exit(1);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function goAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1500);
}

function addBusinessDays(date, n) {
  const d = new Date(date);
  let added = 0;
  const direction = n >= 0 ? 1 : -1;
  n = Math.abs(n);
  while (added < n) {
    d.setDate(d.getDate() + direction);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

async function getAllSequenceIds(page) {
  const topIds = [];
  const inboundIds = [];
  const highVolumeIds = [];
  let doneCollectingTop = false;
  let pageNum = 1;
  while (true) {
    await goAndSettle(page, `https://app.hubspot.com/sequences/${PORTAL_ID}/manage?field=updated_at&order=DESC&page=${pageNum}`);
    const rows = await page.$$eval('table tbody tr', trs =>
      trs.map(tr => {
        const link = tr.querySelector('a[href*="/sequence/"]');
        if (!link) return null;
        const m = link.getAttribute('href').match(/\/sequence\/(\d+)/);
        if (!m) return null;
        const cells = tr.querySelectorAll('td');
        const enrolledText = cells[2] ? cells[2].textContent.trim() : '0';
        const enrolledCount = parseInt(enrolledText.replace(/,/g, ''), 10) || 0;
        return { id: m[1], name: link.textContent.trim(), enrolledCount };
      }).filter(Boolean)
    );
    if (rows.length === 0) break;
    rows.forEach(r => {
      if (!doneCollectingTop) topIds.push(r.id);
      if (/inbound/i.test(r.name)) inboundIds.push(r.id);
      if (r.enrolledCount >= ENROLLED_THRESHOLD) highVolumeIds.push(r.id);
    });
    if (topIds.length >= MAX_SEQUENCES) doneCollectingTop = true;
    pageNum++;
    if (pageNum > 50) break;
    await sleep(300);
  }
  console.log(`Inbound-named sequences found: ${inboundIds.length}`);
  console.log(`High-volume sequences found (>= ${ENROLLED_THRESHOLD} total enrolled): ${highVolumeIds.length}`);
  return [...new Set([
    ...topIds.slice(0, MAX_SEQUENCES),
    ...FORCE_SEQUENCE_IDS,
    ...inboundIds,
    ...highVolumeIds
  ])];
}

async function getStepMap(page, sequenceId) {
  await goAndSettle(page, `https://app.hubspot.com/sequences/${PORTAL_ID}/sequence/${sequenceId}/edit`);
  const stepTexts = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('body *')).filter(el =>
      el.children.length === 0 && el.textContent.trim().length > 0
    );
    return all.map(el => el.textContent.trim()).filter(t => /^\d+\.\s.+Day\s*\d+$/i.test(t));
  });

  const stepMap = {};
  stepTexts.forEach(text => {
    const m = text.match(/^(\d+)\.\s+(.+?)\s*-\s*Day\s*(\d+)$/i);
    if (!m) return;
    const stepNumber = parseInt(m[1], 10);
    const typeLabel = m[2];
    const dayOffset = parseInt(m[3], 10);
    stepMap[stepNumber] = { stepNumber, isEmail: /email/i.test(typeLabel), dayOffset };
  });
  return stepMap;
}

async function scrapeStatusRows(page, sequenceId, status) {
  const url = `https://app.hubspot.com/sequences/${PORTAL_ID}/sequence/${sequenceId}/enrollments/${status}?enrolledBy=ALL_USERS`;
  await goAndSettle(page, url);

  const rows = [];
  let pageNum = 1;
  while (true) {
    const rowData = await page.$$eval('table tbody tr', (trs, statusArg) =>
      trs.map(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 8) return null;
        const enrolledText = cells[3].textContent.trim();
        const detailsText = cells[7].textContent.trim();
        const ownerMatch = enrolledText.match(/by (.+)$/);
        if (!ownerMatch) return null;

        if (statusArg === 'in-progress') {
          const nextStepMatch = detailsText.match(/next step on (.+)$/i);
          const stepCountMatch = detailsText.match(/Step (\d+) of (\d+)/i);
          if (!nextStepMatch || !stepCountMatch) return null;
          return {
            repName: ownerMatch[1].trim(),
            anchorDateText: nextStepMatch[1].trim(),
            anchorStepNum: parseInt(stepCountMatch[1], 10)
          };
        } else {
          const dateMatch = detailsText.match(/on\s+(.+)$/i);
          if (!dateMatch) return null;
          return {
            repName: ownerMatch[1].trim(),
            anchorDateText: dateMatch[1].trim(),
            anchorStepNum: 1
          };
        }
      }).filter(Boolean)
    , status);
    rows.push(...rowData);

    const nextBtn = await page.$('button[aria-label="Next page"], a[aria-label="Next page"]');
    if (!nextBtn) break;
    const isDisabled = await nextBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
    if (isDisabled) break;
    await nextBtn.click();
    await sleep(1000);
    pageNum++;
    if (pageNum > 200) break;
  }
  return rows;
}

function projectEmailDates(contactRow, stepMap) {
  const { anchorStepNum, anchorDateText } = contactRow;
  const anchorDate = new Date(anchorDateText);
  if (isNaN(anchorDate.getTime())) return [];
  const anchorStep = stepMap[anchorStepNum];
  if (!anchorStep) return [];

  const totalSteps = Math.max(...Object.keys(stepMap).map(Number));
  const dates = [];
  for (let j = anchorStepNum; j <= totalSteps; j++) {
    const step = stepMap[j];
    if (!step || !step.isEmail) continue;
    const dayDiff = step.dayOffset - anchorStep.dayOffset;
    const targetDate = dayDiff === 0 ? anchorDate : addBusinessDays(anchorDate, dayDiff);
    dates.push(targetDate.toISOString().slice(0, 10));
  }
  return dates;
}

async function main() {
  const rawCookies = JSON.parse(COOKIES_JSON);
  const cookies = rawCookies.map(c => {
    let sameSite = 'Lax';
    const s = (c.sameSite || '').toLowerCase();
    if (s === 'no_restriction' || s === 'none') sameSite = 'None';
    else if (s === 'strict') sameSite = 'Strict';
    return {
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
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

  const finalRows = [];
  for (let i = 0; i < sequenceIds.length; i++) {
    const id = sequenceIds[i];
    try {
      console.log(`[${i + 1}/${sequenceIds.length}] Checking sequence ${id}...`);
      const inProgressRows = await scrapeStatusRows(page, id, 'in-progress');
      const scheduledRows = await scrapeStatusRows(page, id, 'scheduled');
      const allRows = [...inProgressRows, ...scheduledRows];

      if (allRows.length === 0) {
        console.log('  -> 0 enrollments in progress or scheduled, skipping step map fetch');
        continue;
      }
      console.log(`  -> ${inProgressRows.length} in-progress, ${scheduledRows.length} scheduled-not-started, fetching step map...`);
      const stepMap = await getStepMap(page, id);
      let projectedCount = 0;
      allRows.forEach(row => {
        const dates = projectEmailDates(row, stepMap);
        dates.forEach(sendDate => {
          finalRows.push({ repName: row.repName, sendDate });
          projectedCount++;
        });
      });
      console.log(`  -> projected ${projectedCount} future email sends`);
    } catch (err) {
      console.log(`  -> skipped (${err.message})`);
    }
    await sleep(400);
  }

  console.log(`Total projected email-send rows: ${finalRows.length}`);
  await browser.close();

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'scraped-ui',
    rows: finalRows
  };

  const outPath = path.join(__dirname, '..', 'data', 'scheduled.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
