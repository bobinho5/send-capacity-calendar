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
function msDaysAgo(days) { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); return d.getTime().toString(); }
function nowMs() { return Date.now().toString(); }
function dateKey(msString) { return new Date(parseInt(msString, 10)).toISOString().slice(0, 10); }

async function hubspotFetch(url, options = {}, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.body) {
      console.log('--- REQUEST BODY ---');
      console.log(options.body);
    }
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
      console.log('--- FULL ERROR RESPONSE ---');
      console.log(text);
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

async function fetchEmailsInRange(startMs, endMs) {
  const results = [];
  let after = undefined;
  do {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_timestamp', operator: 'GTE', value: startMs },
          { propertyName: 'hs_timestamp', operator: 'LTE', value: endMs }
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
    if (after) await sleep(400);
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

  const start = msDaysAgo(LOOKBACK_DAYS);
  const end = nowMs();
  console.log(`Fetching emails from ${dateKey(start)} to ${dateKey(end)}...`);
  const allEmails = await fetchEmailsInRange(start, end);
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
