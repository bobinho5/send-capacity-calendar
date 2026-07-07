// fetch-sent-data.js
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.HUBSPOT_TOKEN;
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '30', 10);

if (!TOKEN) {
  console.error('Missing HUBSPOT_TOKEN environment variable.');
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

// Fetch emails for a single, narrow time window (well under HubSpot's
// 10,000-result-per-query cap).
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

// HubSpot's search API caps total paginated results at 10,000 per query.
// To stay safely under that, split the lookback period into one-day windows
// and query each separately.
async function fetchEmailsInRange(lookbackDays) {
  const all = [];
  const now = Date.now();
  for (let i = lookbackDays; i >= 0; i--) {
    const dayStart = new Date(now);
    dayStart.setUTCDate(dayStart.getUTCDate() - i);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCHours(23, 59, 59, 999);

    console.log(`Fetching ${dayStart.toISOString().slice(0, 10)}...`);
    const dayResults = await fetchEmailsForWindow(dayStart.getTime(), Math.min(dayEnd.getTime(), now));
    console.log(`  -> ${dayResults.length} email records`);
    all.push(...dayResults);
    await sleep(300);
  }
  return all;
}

async function main() {
  console.log(`Fetching owners...`);
  const owners = await fetchAllOwners();
  const ownerMap = {};
  owners.forEach(o => {
    ownerMap[o.id] = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || o.id;
  });

  console.log(`Fetching emails across the last ${LOOKBACK_DAYS} days, one day at a time...`);
  const allEmails = await fetchEmailsInRange(LOOKBACK_DAYS);
  console.log(`Fetched ${allEmails.length} total email records (before filtering to sent/outgoing).`);

  const sentEmails = allEmails.filter(e =>
    e.properties.hs_email_direction === 'EMAIL' &&
    e.properties.hs_email_status === 'SENT'
  );
  console.log(`${sentEmails.length} are outgoing + sent.`);

  const counts = {};
  sentEmails.forEach(e => {
    const ownerId = e.properties.hubspot_owner_id;
    const ts = e.properties.hs_timestamp;
    if (!ownerId || !ts) return;
    const key = new Date(ts).toISOString().slice(0, 10);
    counts[ownerId] = counts[ownerId] || {};
    counts[ownerId][key] = (counts[ownerId][key] || 0) + 1;
  });

  const output = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    owners: Object.keys(counts).map(id => ({ id, name: ownerMap[id] || `Owner ${id}` })),
    sends: counts
  };

  const outPath = path.join(__dirname, '..', 'data', 'sent.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
