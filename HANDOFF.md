# IJG Labs Educator List — Handoff

## What this is

A Node + Express backend with a plain HTML/CSS/vanilla JS frontend for collecting private educator whitelist applications and non-educator supporter inquiries for IJG Labs.

- Local source: `/home/ira/dev/ijglabs-educator-list/site/`
- Intended deploy path on `cortex-studio`: `~/apps/ijglabs-educator-list/`
- PM2 entry: `ijglabs-educator-list`
- Port: `3220`
- Public hostname: `https://educator-list.ijglabs.ai`
- GitHub repo URL: `https://github.com/irajgreenberg/ijglabs-educator-list`

## Manual deploy recipe

From the target host:

```bash
cd ~/apps/ijglabs-educator-list
npm install --omit=dev
cp .env.example .env
chmod 600 .env
# edit .env and set at minimum IP_HASH_PEPPER
PORT=3220 node server.js
```

PM2 shape:

```bash
cd ~/apps/ijglabs-educator-list
pm2 start server.js --name ijglabs-educator-list --time
pm2 save
```

If updating an existing deployment:

```bash
cd ~/apps/ijglabs-educator-list
git pull
npm install --omit=dev
pm2 restart ijglabs-educator-list --update-env
```

## Environment variables

Required:

- `PORT=3220`
- `PUBLIC_URL=https://educator-list.ijglabs.ai`
- `IP_HASH_PEPPER=<random secret hex/string>` — required; server refuses to start without it.

Optional:

- `INTERNAL_TOKEN=<secret>` — enables `GET /api/applications.csv` with header `X-Internal-Token`. Leave unset/blank to disable CSV export.
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `NOTIFY_TO`

SMTP notification is fire-and-forget. If any SMTP env var is missing, the server logs `SMTP not configured — skipping notification` once at startup and continues normally.

## Database

SQLite database path:

```bash
/home/ira/dev/ijglabs-educator-list/site/data/applications.db
```

On deployment, the equivalent path will be:

```bash
~/apps/ijglabs-educator-list/data/applications.db
```

The server creates the `data/` directory automatically. `data/`, `*.db`, and `*.db-journal` are gitignored.

## Reading submissions

Via SSH with sqlite3:

```bash
cd ~/apps/ijglabs-educator-list
sqlite3 data/applications.db
.headers on
.mode column
SELECT submitted_at, kind, name, email, title, institution, use_case, expected_students, institution_budget, supporter_interest, notes
FROM applications
ORDER BY submitted_at DESC;
```

CSV export, if `INTERNAL_TOKEN` is set:

```bash
curl -H "X-Internal-Token: $INTERNAL_TOKEN" \
  https://educator-list.ijglabs.ai/api/applications.csv > applications.csv
```

The CSV intentionally omits `ip_hash` and `user_agent`.

## Endpoints

- `GET /` — serves the one-page frontend.
- `GET /healthz` — returns `{ ok: true, count: <row count> }`.
- `POST /api/applications` — accepts JSON educator/supporter applications; same-origin CORS only.
- `GET /api/applications.csv` — optional internal CSV export gated by `INTERNAL_TOKEN`.

## Local verification performed

- `npm install`
- `npm test`
- `npm audit --omit=dev --audit-level=high`
- Local server on `http://localhost:3220/`
- Curl coverage: `/`, `/healthz`, valid educator POST, valid supporter POST, invalid payload 400, forbidden origin 403, CSV without token 401, CSV with token 200.
- Playwright MCP browser coverage: three full screenshot passes across 1440, 1024, 768, and 375 widths in dark and light themes where applicable. Browser form submission was exercised to the success state.
- Screenshots written to `/home/ira/dev/ijglabs-educator-list/screenshots/`.

## Known limits / out of scope

- No captcha in v1.
- No rate limiting in v1. Add Upstash, express-rate-limit, or equivalent before wide public launch.
- No admin UI for browsing submissions.
- No GitHub Actions / CI.
- Public read of submissions is intentionally not enabled.
