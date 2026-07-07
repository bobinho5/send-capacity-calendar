# HubSpot send capacity calendar

A dashboard showing daily email send volume per rep, kept fresh automatically
by a GitHub Action, hosted as a static site via GitHub Pages.

## What updates automatically vs. what doesn't

- **Sent-email history** (`data/sent.json`): fully automatic. Pulled from
  HubSpot's real, documented API every morning. Solid and reliable.
- **Future-scheduled sends** (`data/scheduled.json`): best-effort automatic.
  HubSpot has no API for this, so it's scraped from HubSpot's own
  "Sequences > Scheduled" page using a saved browser session. This is
  inherently more fragile than the API half — if HubSpot changes their UI,
  the scraper will need its selectors updated (see `scripts/scrape-scheduled.js`
  for the TODOs). There's a manual CSV upload on the dashboard itself as a
  fallback for whenever the scraper falls behind.

## One-time setup

### 1. Push this to a GitHub repo
Create a new repo and push these files as-is.

### 2. Create a HubSpot Private App (for the sent-data half)
In HubSpot: Settings → Integrations → Private Apps → Create a private app.
Grant it read scope on: `crm.objects.emails.read` and `crm.objects.owners.read`
(read-only — no write scopes needed for this).
Copy the generated access token.

### 3. Add repo secrets
Go to your GitHub repo → Settings → Secrets and variables → Actions, and add:

| Secret name | Value |
|---|---|
| `HUBSPOT_TOKEN` | The Private App access token from step 2 |
| `HUBSPOT_PORTAL_ID` | Your numeric HubSpot account/portal ID |
| `HUBSPOT_SESSION_COOKIES` | See step 4 below |

### 4. Capture a HubSpot session cookie (for the scheduled-data half)
This is deliberately manual — we don't automate your login itself.

1. Log into HubSpot normally, in a regular browser.
2. Open DevTools → Application tab → Cookies → `https://app.hubspot.com`.
3. Export the full cookie list as JSON (a trusted cookie-export browser
   extension works, or copy the values manually into this shape):
   ```json
   [
     { "name": "cookie-name", "value": "...", "domain": ".hubspot.com", "path": "/" }
   ]
   ```
4. Paste that JSON array as the value of the `HUBSPOT_SESSION_COOKIES` secret.
5. **This cookie will expire** (typically after a few weeks of inactivity, or
   sooner if you log out elsewhere). When the scraper starts failing, just
   repeat this step with a fresh cookie export.

### 5. Enable GitHub Pages
Repo → Settings → Pages → Deploy from a branch → `main` → `/ (root)`.
Your dashboard will be live at `https://<your-username>.github.io/<repo-name>/`.

### 6. Test the Action manually
Repo → Actions → "Sync HubSpot send data" → Run workflow.
Check that `data/sent.json` gets populated with real numbers. Check the logs
for `scrape-scheduled.js` — it will very likely need the selector TODOs fixed
before it produces real rows (see below).

## Fixing the scraper selectors

`scripts/scrape-scheduled.js` has placeholder CSS selectors (`data-test-id="scheduled-email-row"`
etc.) that are educated guesses, not verified against a real HubSpot session.
To fix them:

1. Log into HubSpot, open the Sequences → Scheduled page.
2. Open DevTools, inspect the actual row elements and find real selectors
   (or check if there's an "Export" button — if there is, use that instead
   of scraping table rows directly, it'll be far more reliable; there's a
   commented-out example for that pattern in the script).
3. Update the script, commit, and re-run the Action.

If you have Claude in Chrome available, you can also just open the real
Scheduled page with it connected and ask it to identify the correct selectors
directly from the live DOM — much faster than guessing blind.

## Local testing

```
cd scripts
npm install
HUBSPOT_TOKEN=your-token node fetch-sent-data.js
HUBSPOT_SESSION_COOKIES='[...]' HUBSPOT_PORTAL_ID=12345 node scrape-scheduled.js
```

## A note on the scraping approach

Automating access to HubSpot's own UI (rather than their public API) may or
may not be permitted under HubSpot's Terms of Service — this hasn't been
independently verified. It's worth a quick check with your HubSpot admin or
their terms before relying on this in production. The API-backed sent-data
half has no such concern.
