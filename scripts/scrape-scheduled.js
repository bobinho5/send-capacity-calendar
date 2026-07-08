// scrape-scheduled.js
//
// Pulls forward-looking projected email-send dates for sequence enrollments
// that either haven't started yet ("Scheduled" status -- bulk-enrolled
// contacts HubSpot is staggering to respect daily send limits) or are
// already partway through ("In progress" status). HubSpot has no API for
// this, so it's scraped from the Sequences UI using a saved session cookie.
//
// SEQUENCE DISCOVERY -- scoped to a fixed, known list of AEs, with a hard
// cap on how many of their sequences actually get checked in detail:
//   1. Pool every sequence owned by anyone on AE_NAMES, or by
//      TEMPLATE_OWNER_NAME (Bobby Mohr owns template sequences that real
//      AEs enroll contacts into, e.g. "THSCA Template FB/S&C/AD 2026",
//      even though he's not an AE himself).
//   2. From that pool, take the top MAX_RECENT most recently modified.
//   3. From whatever's left over, take the top MAX_EXTRA_HIGH_VOLUME more
//      by total-enrolled count. This is the guardrail against an owner
//      (typically Bobby Mohr) sitting on hundreds of old template
//      sequences that would otherwise all get checked one by one.
//   4. Any sequence whose name contains "inbound" (direct ?q=inbound
//      search, independent of the owner pool/cap above).
// Plus any explicitly forced IDs (FORCE_SEQUENCE_IDS).
//
// IMPORTANT: which AE a future email gets attributed to is NEVER based on
// sequence ownership -- it's read per-contact from the "Enrolled ... by
// <name>" text on each row. Ownership only affects which sequences we
// bother checking, not who a projected send gets credited to.
//
// For each contact we know one certain calendar date -- either their
// enrollment's first send date (Scheduled) or their immediate next-step
// date (In progress). Combined with the sequence's Steps tab, which labels
// every step with a cumulative business-day offset, we project every
// remaining email step's calendar date via business-day math.
//
// Two different tables in HubSpot's UI briefly show a "Loading" placeholder
// before real data renders (the enrollment table's "Enrolled" column, and
// the Manage list's own rows). We poll for real content rather than
// trusting a fixed sleep.
//
// Requires env vars: HUBSPOT_SESSION_COOKIES (JSON array), HUBSPOT_PORTAL_ID
// Optional env vars: FORCE_SEQUENCE_IDS, MAX_RECENT (default 50),
//   MAX_EXTRA_HIGH_VOLUME (default 10)
// Writes: ../data/scheduled.json

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIES_JSON = process.env.HUBSPOT_SESSION_COOKIES;
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
const MAX_RECENT = parseInt(process.env.MAX_RECENT || '50', 10);
const MAX_EXTRA_HIGH_VOLUME = parseInt(process.env.MAX_EXTRA_HIGH_VOLUME || '10', 10);
const FORCE_SEQUENCE_IDS = (process.env.FORCE_SEQUENCE_IDS || '272570396,76707862,307480679,307295410')
  .split(',').map(s => s.trim()).filter(Boolean);

const AE_NAMES = [
  'Ben Slingerland', 'Cameron Smith', 'Daniel Kirwan', 'Ethan Barr',
  'Fraser Campbell', 'Jack Isherwood', 'Jacob Asbill', 'Jake Pace',
  'Jake Seymour', 'Jason Tilton', 'Jessica Brodsky', 'Maddy Haro',
  'Mario Felix', 'Mathew Young', 'Michael Frauenheim', 'Nando Benning',
  'Sam Boyes', 'Sean Chetcuti'
];
const TEMPLATE_OWNER_NAME = 'Bobby Mohr';

if (!COOKIES_JSON || !PORTAL_ID) {
  console.error('Missing HUBSPOT_SESSION_COOKIES or HUBSPOT_PORTAL_ID environment variable.');
  process.exit(1);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function goAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1500);
}

async function waitForEnrolledDataToLoad(page, maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const stillLoading = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      if (rows.length === 0) return false;
      const text = rows[0].querySelectorAll('td')[3]?.textContent.trim() || '';
      return text === 'Loading' || text === '';
    });
    if (!stillLoading) return;
    await sleep(400);
  }
}

async function waitForManageRowsToLoad(page, maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const hasLinks = await page.evaluate(() => {
      return document.querySelectorAll('table tbody tr a[href*="/sequence/"]').length > 0;
    });
    if (hasLinks) return true;
    await sleep(400);
  }
  return false;
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

function approxDaysAgo(text) {
  if (!text) return 999999;
  const t = text.toLowerCase().trim();
  if (/just now|minute|hour/.test(t)) return 0;
  const m = t.match(/(a|an|\d+)\s+(day|week|month|year)/);
  if (!m) return 999999;
  const n = m[1] === 'a' || m[1] === 'an' ? 1 : parseInt(m[1], 10);
  const unit = m[2];
  if (unit === 'day') return n;
  if (unit === 'week') return n * 7;
  if (unit === 'month') return n * 30;
  if (unit === 'year') return n * 365;
  return 999999;
}

async function setPageSizeTo100(page) {
  try {
    const menuBtn = page.locator('button:has-text("per page")').first();
    if (await menuBtn.count() === 0) return;
    await menuBtn.click();
    await sleep(400);
    const option = page.locator('button:has-text("100 per page")').first();
    if (await option.count() === 0) return;
    await option.click();
    await sleep(1000);
    await waitForEnrolledDataToLoad(page);
  } catch (err) {
    // Non-fatal.
  }
}

async function readManageRowsDetailed(page) {
  return page.$$eval('table tbody tr', trs =>
    trs.map(tr => {
      const link = tr.querySelector('a[href*="/sequence/"]');
      if (!link) return null;
      const m = link.getAttribute('href').match(/\/sequence\/(\d+)/);
      if (!m) return null;
      const cells = tr.querySelectorAll('td');
      const enrolledText = cells[2] ? cells[2].textContent.trim() : '0';
      const enrolledCount = parseInt(enrolledText.replace(/,/g, ''), 10) || 0;
      const dateModifiedText = cells[6] ? cells[6].textContent.trim() : '';
      return { id: m[1], name: link.textContent.trim(), enrolledCount, dateModifiedText };
    }).filter(Boolean)
  );
}

async function readManageRowsSimple(page) {
  return page.$$eval('table tbody tr', trs =>
    trs.map(tr => {
      const link = tr.querySelector('a[href*="/sequence/"]');
      if (!link) return null;
      const m = link.getAttribute('href').match(/\/sequence\/(\d+)/);
      if (!m) return null;
      return { id: m[1], name: link.textContent.trim() };
    }).filter(Boolean)
  );
}

async function searchSequencesByName(page, term) {
  const results = [];
  let pageNum = 1;
  while (true) {
    await goAndSettle(page, `https://app.hubspot.com/sequences/${PORTAL_ID}/manage?q=${encodeURIComponent(term)}&page=${pageNum}`);
    await waitForManageRowsToLoad(page, 5000);
    const rows = await readManageRowsSimple(page);
    if (rows.length === 0) break;
    results.push(...rows);
    const nextBtn = await page.$('button[aria-label="Next page"], a[aria-label="Next page"]');
    if (!nextBtn) break;
    const isDisabled = await nextBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
    if (isDisabled) break;
    await nextBtn.click();
    await sleep(1000);
    pageNum++;
    if (pageNum > 20) break;
  }
  return results;
}

async function sweepByOwner(page, ownerName) {
  await goAndSettle(page, `https://app.hubspot.com/sequences/${PORTAL_ID}/manage`);

  const label = page.locator('label:has-text("Owner:")').first();
  if (await label.count() === 0) return [];
  await label.click();
  await sleep(500);

  const input = page.locator('input[placeholder="Search owner"]');
  if (await input.count() === 0) return [];
  await input.click();
  await input.type(ownerName, { delay: 40 });

  let hasUsersSection = false;
  const start = Date.now();
  while (Date.now() - start < 6000) {
    hasUsersSection = await page.evaluate(() =>
      Array.from(document.querySelectorAll('body *')).some(e => e.children.length === 0 && e.textContent.trim() === 'Users')
    );
    if (hasUsersSection) break;
    await sleep(500);
  }
  if (!hasUsersSection) return [];

  const resultLocator = page.locator('text=/\\d+ sequences/').first();
  if (await resultLocator.count() === 0) return [];
  await resultLocator.click();
  await sleep(1200);

  const rows = [];
  let pageNum = 1;
  while (true) {
    await waitForManageRowsToLoad(page);
    const pageRows = await readManageRowsDetailed(page);
    if (pageRows.length === 0) break;
    rows.push(...pageRows);

    const nextBtn = await page.$('button[aria-label="Next page"], a[aria-label="Next page"]');
    if (!nextBtn) break;
    const isDisabled = await nextBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
    if (isDisabled) break;
    await nextBtn.click();
    await sleep(1000);
    pageNum++;
    if (pageNum > 50) break;
  }
  return rows;
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
  await waitForEnrolledDataToLoad(page);

  const hasAnyRows = (await page.$$('table tbody tr')).length > 0;
  if (hasAnyRows) {
    await setPageSizeTo100(page);
  }

  const rows = [];
  let pageNum = 1;
  let droppedForLoading = 0;
  while (true) {
    await waitForEnrolledDataToLoad(page);
    const pageResult = await page.$$eval('table tbody tr', (trs, statusArg) => {
      let dropped = 0;
      const parsed = trs.map(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 8) return null;
        const enrolledText = cells[3].textContent.trim();
        const detailsText = cells[7].textContent.trim();
        const ownerMatch = enrolledText.match(/by (.+)$/);
        if (!ownerMatch) {
          if (enrolledText === 'Loading' || enrolledText === '') dropped++;
          return null;
        }

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
      }).filter(Boolean);
      return { parsed, dropped };
    }, status);
    rows.push(...pageResult.parsed);
    droppedForLoading += pageResult.dropped;

    const nextBtn = await page.$('button[aria-label="Next page"], a[aria-label="Next page"]');
    if (!nextBtn) break;
    const isDisabled = await nextBtn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
    if (isDisabled) break;
    await nextBtn.click();
    await sleep(1000);
    pageNum++;
    if (pageNum > 200) break;
  }
  if (droppedForLoading > 0) {
    console.log(`    (warning: ${droppedForLoading} row(s) still showed "Loading" after max wait and were skipped)`);
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

  console.log('Searching for "inbound"-named sequences...');
  const inboundResults = await searchSequencesByName(page, 'inbound');
  console.log(`Found ${inboundResults.length} inbound-named sequences.`);

  console.log('Pooling sequences owned by the AE roster + Bobby Mohr...');
  const ownersToSweep = [...AE_NAMES, TEMPLATE_OWNER_NAME];
  const pool = new Map();
  for (let i = 0; i < ownersToSweep.length; i++) {
    const ownerName = ownersToSweep[i];
    try {
      const rows = await sweepByOwner(page, ownerName);
      rows.forEach(r => pool.set(r.id, r));
      console.log(`  [${i + 1}/${ownersToSweep.length}] ${ownerName}: ${rows.length} sequences owned`);
    } catch (err) {
      console.log(`  [${i + 1}/${ownersToSweep.length}] ${ownerName}: skipped (${err.message})`);
    }
    await sleep(300);
  }
  const poolArr = [...pool.values()];
  console.log(`Owner pool: ${poolArr.length} distinct sequences before applying recency/volume caps.`);

  const byRecency = [...poolArr].sort((a, b) => approxDaysAgo(a.dateModifiedText) - approxDaysAgo(b.dateModifiedText));
  const recentSet = byRecency.slice(0, MAX_RECENT);
  const recentIds = new Set(recentSet.map(r => r.id));

  const remaining = poolArr.filter(r => !recentIds.has(r.id));
  const byVolume = remaining.sort((a, b) => b.enrolledCount - a.enrolledCount).slice(0, MAX_EXTRA_HIGH_VOLUME);

  console.log(`Capped to ${recentSet.length} most-recent + ${byVolume.length} additional high-volume = ${recentSet.length + byVolume.length} sequences from the owner pool.`);

  const sequenceIds = [...new Set([
    ...FORCE_SEQUENCE_IDS,
    ...inboundResults.map(r => r.id),
    ...recentSet.map(r => r.id),
    ...byVolume.map(r => r.id)
  ])];
  console.log(`Found ${sequenceIds.length} total sequences to check in detail.`);

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
