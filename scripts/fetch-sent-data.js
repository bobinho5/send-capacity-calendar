// fetch-sent-data.js
//
// Pulls sent-email counts by owner and by day from HubSpot's public CRM
// API, using a Private App access token (no scraping, no browser).
//
// INCREMENTAL: past days don't change once they're in the past, so instead
// of re-fetching the full LOOKBACK_DAYS window every run, we only fetch the
// most recent FRESH_FETCH_DAYS days fresh (today + yesterday by default,
// to catch anything that posted late) and merge that into whatever's
// already committed in data/sent.json. Older days are carried forward
// untouched. The full LOOKBACK_DAYS window is still enforced as a rolling
// retention window -- anything older gets trimmed off either way.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.HUBSPOT_TOKEN;
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '30', 10);
const FRESH_FETCH_DAYS = parseInt(process.env.FRESH_FETCH_DAYS || '2', 10);

if (!TOKEN) {
  console.error('Missing HUBSPOT_TOKEN environment variable.');
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';
const OUT_PATH = path.join(__dirname, '..', 'data', 'sent.json');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function msDaysAgo(days) { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
function nowMs() { return Date.now(); }
function dateKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
}

async function hubspotFetch(url, options = {}, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (res.status === 429) {
      const wait = 1500 * (attempt + 1);
      console.log(`Rate limited, waiting ${wait}ms before retry ${attempt + 1}/${retries}...`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HubSpot API error ${res.status}: ${text}`);
    }
    return res.json();
  }
  throw new Error('HubSpot API: exceeded retry attempts after repeated rate limiting.');
}

async function fetchAllOwners() {
  const owners = [];
  let after = undefined;
  do {
    const url = new URL(`${BASE}/crm/v3/owners`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const data = await hubspotFetch(url.toString());
    owners.push(...data.results.filter(o => !o.archived));
    after = data.paging && data.paging.next ? data.paging.next.after : undefined;
    if (after) await sleep(400);
  } while (after);
  return owners;
}

async function fetchEmailsForWindow(startMs, endMs) {
  const results = [];
  let after = undefined;
  do {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_timestamp', operator: 'GTE', value: startMs.toString() },
          { propertyName: 'hs_timestamp', operator: 'LTE', value: endMs.toString() }
        ]
      }],
      properties: ['hubspot_owner_id', 'hs_timestamp', 'hs_email_direction', 'hs_email_status'],
      limit: 100,
      ...(after ? { after } : {})
    };
    const data = await hubspotFetch(`${BASE}/crm/v3/objects/emails/search`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    results.push(...data.results);
    after = data.paging && data.paging.next ? data.paging.next.after : undefined;
    if (after) await sleep(350);
  } while (after);
  return results;
}

async function fetchFreshEmails(freshDays) {
  const all = [];
  const now = Date.now();
  for (let i = freshDays - 1; i >= 0; i--) {
    const dayStart = new Date(now);
    dayStart.setUTCDate(dayStart.getUTCDate() - i);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCHours(23, 59, 59, 999);

    console.log(`Fetching ${dateKey(dayStart.getTime())}...`);
    const dayResults = await fetchEmailsForWindow(dayStart.getTime(), Math.min(dayEnd.getTime(), now));
    console.log(`  -> ${dayResults.length} email records`);
    all.push(...dayResults);
    await sleep(300);
  }
  return all;
}

async function main() {
  const existing = loadExisting();
  const isIncremental = !!existing;
  console.log(isIncremental
    ? `Existing data/sent.json found -- doing an incremental refresh of the last ${FRESH_FETCH_DAYS} day(s) only.`
    : `No existing data/sent.json found -- doing a full ${LOOKBACK_DAYS}-day fetch (first run).`);

  console.log('Fetching owners...');
  const owners = await fetchAllOwners();
  const ownerNameMap = {};
  owners.forEach(o => {
    ownerNameMap[o.id] = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || o.id;
  });

  const daysToFetch = isIncremental ? FRESH_FETCH_DAYS : LOOKBACK_DAYS;
  const allEmails = await fetchFreshEmails(daysToFetch);
  console.log(`Fetched ${allEmails.length} total email records (before filtering to sent/outgoing).`);

  const sentEmails = allEmails.filter(e =>
    e.properties.hs_email_direction === 'EMAIL' &&
    e.properties.hs_email_status === 'SENT'
  );
  console.log(`${sentEmails.length} are outgoing + sent.`);

  const freshCounts = {};
  sentEmails.forEach(e => {
    const ownerId = e.properties.hubspot_owner_id;
    const ts = e.properties.hs_timestamp;
    if (!ownerId || !ts) return;
    const key = dateKey(ts);
    freshCounts[ownerId] = freshCounts[ownerId] || {};
    freshCounts[ownerId][key] = (freshCounts[ownerId][key] || 0) + 1;
  });

  const mergedSends = existing && existing.sends ? JSON.parse(JSON.stringify(existing.sends)) : {};

  const freshDateKeys = [];
  for (let i = daysToFetch - 1; i >= 0; i--) {
    freshDateKeys.push(dateKey(msDaysAgo(i)));
  }
  const allOwnerIdsInvolved = new Set([
    ...Object.keys(mergedSends),
    ...Object.keys(freshCounts)
  ]);
  allOwnerIdsInvolved.forEach(ownerId => {
    mergedSends[ownerId] = mergedSends[ownerId] || {};
    freshDateKeys.forEach(dk => {
      mergedSends[ownerId][dk] = (freshCounts[ownerId] && freshCounts[ownerId][dk]) || 0;
    });
  });

  const cutoffKey = dateKey(msDaysAgo(LOOKBACK_DAYS));
  Object.keys(mergedSends).forEach(ownerId => {
    Object.keys(mergedSends[ownerId]).forEach(dk => {
      if (dk < cutoffKey) delete mergedSends[ownerId][dk];
    });
  });

  const mergedOwnerNames = {};
  if (existing && existing.owners) existing.owners.forEach(o => { mergedOwnerNames[o.id] = o.name; });
  Object.entries(ownerNameMap).forEach(([id, name]) => { mergedOwnerNames[id] = name; });

  const finalOwnerIds = Object.keys(mergedSends).filter(id =>
    Object.values(mergedSends[id]).some(c => c > 0)
  );

  const output = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    owners: finalOwnerIds.map(id => ({ id, name: mergedOwnerNames[id] || `Owner ${id}` })),
    sends: Object.fromEntries(finalOwnerIds.map(id => [id, mergedSends[id]]))
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUT_PATH} (${finalOwnerIds.length} owners with activity in the retained window).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
