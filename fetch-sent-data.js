// fetch-sent-data.js
//
// Pulls real sent-email counts by owner and by day from HubSpot's public
// CRM API, using a Private App access token (no scraping, no browser).
//
// Requires env var: HUBSPOT_TOKEN
// Writes: ../data/sent.json
//
// HubSpot API docs referenced:
//   Search emails:  POST https://api.hubapi.com/crm/v3/objects/emails/search
//   List owners:    GET  https://api.hubapi.com/crm/v3/owners
//
// NOTE: property names (hs_email_direction, hs_email_status, hs_timestamp,
// hubspot_owner_id) match HubSpot's default one-to-one email engagement
// schema as of this writing. If your portal has renamed or removed any of
// these, check Settings > Properties > Email in HubSpot and adjust below.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.HUBSPOT_TOKEN;
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '30', 10);

if (!TOKEN) {
  console.error('Missing HUBSPOT_TOKEN environment variable.');
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function dateKey(isoString) {
  return isoString.slice(0, 10); // YYYY-MM-DD
}

async function hubspotFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API error ${res.status}: ${text}`);
  }
  return res.json();
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
  } while (after);
  return owners;
}

async function fetchSentEmails(startIso, endIso) {
  const results = [];
  let after = undefined;
  do {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_email_direction', operator: 'EQ', value: 'EMAIL' },
          { propertyName: 'hs_email_status', operator: 'EQ', value: 'SENT' },
          { propertyName: 'hs_timestamp', operator: 'BETWEEN', value: startIso, highValue: endIso }
        ]
      }],
      properties: ['hubspot_owner_id', 'hs_timestamp'],
      limit: 100,
      ...(after ? { after } : {})
    };
    const data = await hubspotFetch(`${BASE}/crm/v3/objects/emails/search`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    results.push(...data.results);
    after = data.paging && data.paging.next ? data.paging.next.after : undefined;
  } while (after);
  return results;
}

async function main() {
  console.log(`Fetching owners...`);
  const owners = await fetchAllOwners();
  const ownerMap = {};
  owners.forEach(o => {
    ownerMap[o.id] = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || o.id;
  });

  const start = isoDateDaysAgo(LOOKBACK_DAYS);
  const end = new Date().toISOString();
  console.log(`Fetching sent emails from ${start} to ${end}...`);
  const emails = await fetchSentEmails(start, end);
  console.log(`Fetched ${emails.length} sent-email records.`);

  const counts = {};
  emails.forEach(e => {
    const ownerId = e.properties.hubspot_owner_id;
    const ts = e.properties.hs_timestamp;
    if (!ownerId || !ts) return;
    const key = dateKey(ts);
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
