// scrape-scheduled.js
//
// Pulls forward-looking projected email-send dates for in-progress sequence
// enrollments. HubSpot has no API for this, so it's scraped from the
// Sequences UI using a saved session cookie.
//
// IMPORTANT: this version projects the FULL remaining chain of email steps
// for each contact, not just the immediate next step. Each sequence's Steps
// tab labels every step with a cumulative business-day offset (e.g. "3.
// Automated Email - Day 3"). Combined with the one calendar date we know
// for certain (the contact's immediate next-step date, shown in the
// Enrollments table), we can project every later email step's calendar
// date by adding the business-day difference between offsets.
//
// Requires env vars: HUBSPOT_SESSION_COOKIES (JSON array), HUBSPOT_PORTAL_ID
// Optional env vars: MAX_SEQUENCES (default 50), FORCE_SEQUENCE_IDS
//   (comma-separated sequence IDs to always include regardless of ranking)
// Writes: ../data/scheduled.json

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIES_JSON = process.env.HUBSPOT_SESSION_COOKIES;
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const MAX_SEQUENCES = parseInt(process.env.MAX_SEQUENCES || '50', 10);
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

// Add N business days (Mon-Fri) to a date, skipping weekends.
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
  const topIds = [...new Set(ids)].slice(0, MAX_SEQUENCES);
  FORCE_SEQUENCE_IDS.forEach(id => {
    if (!topIds.includes(id)) topIds.push(id);
  });
  return topIds;
}

// Scrapes a sequence's Steps tab and returns { stepNumber, isEmail, dayOffset }
// for every step.
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

async function scrapeEnrollmentRows(page, sequenceId) {
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
        const stepCountMatch = detailsText.match(/Step (\d+) of (\d+)/i);
        if (!ownerMatch || !nextStepMatch || !stepCountMatch) return null;
        return {
          repName: ownerMatch[1].trim(),
          nextStepText: nextStepMatch[1].trim(),
          nextStepNum: parseInt(stepCountMatch[1], 10),
          totalSteps: parseInt(stepCountMatch[2], 10)
        };
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

// Projects every remaining email-send date for a contact.
function projectEmailDates(contactRow, stepMap) {
  const { nextStepNum, totalSteps, nextStepText } = contactRow;
  const anchorDate = new Date(nextStepText);
  if (isNaN(anchorDate.getTime())) return [];
  const anchorStep = stepMap[nextStepNum];
  if (!anchorStep) return [];

  const dates = [];
  for (let j = nextStepNum; j <= totalSteps; j++) {
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
  console.log(`Found ${sequenceIds.length} sequences to check (including forced: ${FORCE_SEQUENCE_IDS.join(', ')}).`);

  const finalRows = [];
  for (let i = 0; i < sequenceIds.length; i++) {
    const id = sequenceIds[i];
    try {
      console.log(`[${i + 1}/${sequenceIds.length}] Checking sequence ${id}...`);
      const enrollmentRows = await scrapeEnrollmentRows(page, id);
      if (enrollmentRows.length === 0) {
        console.log('  -> 0 in-progress enrollments, skipping step map fetch');
        continue;
      }
      console.log(`  -> ${enrollmentRows.length} in-progress enrollments, fetching step map...`);
      const stepMap = await getStepMap(page, id);
      let projectedCount = 0;
      enrollmentRows.forEach(row => {
        const dates = projectEmailDates(row, stepMap);
        dates.forEach(sendDate => {
          finalRows.push({ repName: row.repName, sendDate });
          projectedCount++;
        });
      });
      console.log(`  -> projected ${projectedCount} future email sends across remaining steps`);
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
