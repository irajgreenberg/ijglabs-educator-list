const crypto = require('crypto');
const express = require('express');

const COOKIE_NAME = 'edl_admin';
const COOKIE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function loadConfig() {
  const emails = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const password = process.env.ADMIN_PASSWORD || '';
  const secret = process.env.SESSION_SECRET || '';
  return { emails, password, secret, ready: emails.length > 0 && password.length >= 8 && secret.length >= 32 };
}

const config = loadConfig();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtTs(ms) {
  if (!ms) return '—';
  return new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || !config.secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  let a, b;
  try { a = Buffer.from(sig); b = Buffer.from(expected); } catch { return null; }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!payload || typeof payload !== 'object' || !payload.email) return null;
  if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
  if (!config.emails.includes(payload.email)) return null;
  return payload;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, email) {
  const exp = Date.now() + COOKIE_MAX_AGE_MS;
  const token = signSession({ email, exp, iat: Date.now() });
  const secure = process.env.NODE_ENV === 'production' || process.env.PUBLIC_URL?.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' || process.env.PUBLIC_URL?.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`);
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies[COOKIE_NAME]);
  if (!session) {
    if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') {
      const next = encodeURIComponent(req.originalUrl || req.url);
      return res.redirect(`/admin/login?next=${next}`);
    }
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.adminEmail = session.email;
  next();
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function migrateSchema(db) {
  const cols = db.prepare("PRAGMA table_info('applications')").all().map((row) => row.name);
  const additions = [];
  if (!cols.includes('status')) additions.push("ALTER TABLE applications ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  if (!cols.includes('admin_notes')) additions.push('ALTER TABLE applications ADD COLUMN admin_notes TEXT');
  if (!cols.includes('reviewed_at')) additions.push('ALTER TABLE applications ADD COLUMN reviewed_at INTEGER');
  if (!cols.includes('reviewed_by')) additions.push('ALTER TABLE applications ADD COLUMN reviewed_by TEXT');
  for (const sql of additions) db.exec(sql);
  db.exec('CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status)');
}

const STATUSES = ['pending', 'accepted', 'declined', 'spam'];

function layout({ title, body, adminEmail, activeTab }) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(title)} — IJG Labs / Educators / Admin</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/admin.css">
<script>document.documentElement.dataset.theme = localStorage.getItem('ijg-educator-list-theme') || 'dark';</script>
</head>
<body class="admin-page">
<header class="site-header">
  <a class="mark" href="/admin/applications">IJG LABS<br>EDUCATORS · ADMIN</a>
  <nav class="nav" aria-label="Primary">
    <a href="/admin/applications" ${activeTab === 'list' ? 'aria-current="page"' : ''}>applications</a>
    <a href="/admin/applications.csv">csv</a>
    <a href="/">public</a>
    <button class="theme-toggle" type="button" aria-label="Toggle theme">light</button>
  </nav>
</header>
<main id="main">${body}</main>
<footer class="site-footer admin-footer">
  <p>Signed in as <span class="who">${esc(adminEmail || '')}</span></p>
  <form method="POST" action="/admin/logout" class="logout-form"><button class="link-button" type="submit">log out</button></form>
</footer>
<script src="/admin.js" defer></script>
</body>
</html>`;
}

function renderLogin({ error, nextPath }) {
  const opts = config.emails.map((email) => `<option value="${esc(email)}">${esc(email)}</option>`).join('');
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin login — IJG Labs / Educators</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/admin.css">
<script>document.documentElement.dataset.theme = localStorage.getItem('ijg-educator-list-theme') || 'dark';</script>
</head>
<body class="admin-page admin-login">
<header class="site-header">
  <a class="mark" href="/">IJG LABS<br>EDUCATORS · ADMIN</a>
  <nav class="nav" aria-label="Primary">
    <a href="/">public</a>
    <button class="theme-toggle" type="button" aria-label="Toggle theme">light</button>
  </nav>
</header>
<main id="main">
  <section class="grid-section hero">
    <p class="kicker">00 / admin</p>
    <h1>Sign in.</h1>
  </section>
  <section class="grid-section">
    <p class="section-number">01</p>
    <h2>Identify yourself</h2>
    <div class="form-wrap">
      <form method="POST" action="/admin/login" class="admin-form">
        <input type="hidden" name="next" value="${esc(nextPath || '/admin/applications')}">
        ${error ? `<div class="server-banner" role="alert">${esc(error)}</div>` : ''}
        <div class="form-group">
          <p class="group-label">01.a / identity</p>
          <div class="form-grid two-col">
            <label class="field"><span>Email</span>
              <select name="email" required>${opts}</select>
            </label>
            <label class="field"><span>Password</span>
              <input name="password" type="password" autocomplete="current-password" required>
            </label>
          </div>
        </div>
        <button class="primary-button" type="submit">Sign in</button>
      </form>
    </div>
  </section>
</main>
<footer class="site-footer">
  <p>Restricted area. Submissions are stored privately.</p>
  <a href="https://github.com/irajgreenberg/ijglabs-educator-list">GitHub</a>
</footer>
<script src="/admin.js" defer></script>
</body>
</html>`;
}

function renderList({ adminEmail, rows, currentStatus, counts }) {
  const filterLink = (status, label) => {
    const active = status === currentStatus ? ' aria-current="page"' : '';
    const count = status === 'all' ? counts.all : (counts[status] || 0);
    const href = status === 'all' ? '/admin/applications' : `/admin/applications?status=${status}`;
    return `<a class="filter-pill" href="${href}"${active}>${esc(label)} <span class="pill-count">${count}</span></a>`;
  };
  const rowsHtml = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No applications match this filter.</td></tr>`
    : rows.map((r) => `
      <tr>
        <td class="mono small">${fmtTs(r.submitted_at)}</td>
        <td><a class="row-link" href="/admin/applications/${esc(r.id)}">${esc(r.name)}</a></td>
        <td>${esc(r.email)}</td>
        <td>${esc(r.kind)}</td>
        <td>${esc(r.institution || '—')}</td>
        <td><span class="status status-${esc(r.status || 'pending')}">${esc(r.status || 'pending')}</span></td>
      </tr>`).join('');
  const body = `
    <section class="grid-section hero">
      <p class="kicker">00 / applications</p>
      <h1>Whitelist applications.</h1>
      <p class="lead">Review submissions, mark each as accepted, declined, or spam. Notes are private.</p>
    </section>
    <section class="grid-section">
      <p class="section-number">01</p>
      <h2>Filter</h2>
      <div class="filter-bar">
        ${filterLink('all', 'all')}
        ${filterLink('pending', 'pending')}
        ${filterLink('accepted', 'accepted')}
        ${filterLink('declined', 'declined')}
        ${filterLink('spam', 'spam')}
      </div>
    </section>
    <section class="grid-section">
      <p class="section-number">02</p>
      <h2>Submissions</h2>
      <div class="table-wrap">
        <table class="admin-table">
          <thead>
            <tr><th>Submitted</th><th>Name</th><th>Email</th><th>Kind</th><th>Institution</th><th>Status</th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </section>
  `;
  return layout({ title: 'Applications', body, adminEmail, activeTab: 'list' });
}

function renderDetail({ adminEmail, row, saved }) {
  const statusOpts = STATUSES.map((s) => `<option value="${s}"${row.status === s ? ' selected' : ''}>${s}</option>`).join('');
  const optional = (label, value) => `<dt>${esc(label)}</dt><dd>${value ? esc(value) : '<span class="muted">—</span>'}</dd>`;
  const supporterBlock = row.kind === 'supporter' ? `
    <dl class="kv">
      ${optional('Supporter interest', row.supporter_interest)}
    </dl>` : '';
  const educatorBlock = row.kind === 'educator' ? `
    <dl class="kv">
      ${optional('Title or role', row.title)}
      ${optional('Institution', row.institution)}
      ${optional('Use case', row.use_case)}
      ${optional('Expected students', row.expected_students != null ? row.expected_students : '')}
      ${optional('Institution budget', row.institution_budget)}
    </dl>` : '';
  const body = `
    <section class="grid-section hero">
      <p class="kicker">00 / detail</p>
      <h1>${esc(row.name)}</h1>
      <p class="lead">${esc(row.email)} · ${esc(row.kind)} · submitted ${fmtTs(row.submitted_at)}</p>
      <p class="back-link"><a href="/admin/applications">← back to applications</a></p>
    </section>
    <section class="grid-section">
      <p class="section-number">01</p>
      <h2>Submission</h2>
      ${educatorBlock}
      ${supporterBlock}
      <dl class="kv">
        ${optional('Additional notes (from applicant)', row.notes)}
      </dl>
    </section>
    <section class="grid-section">
      <p class="section-number">02</p>
      <h2>Review</h2>
      <div class="form-wrap">
        ${saved ? '<div class="success-banner" role="status">Saved.</div>' : ''}
        <form method="POST" action="/admin/applications/${esc(row.id)}" class="admin-form">
          <div class="form-group">
            <p class="group-label">02.a / status</p>
            <div class="form-grid two-col">
              <label class="field"><span>Status</span>
                <select name="status" required>${statusOpts}</select>
              </label>
              <div class="field meta-field">
                <span>Last reviewed</span>
                <p class="meta-line">${row.reviewed_by ? esc(row.reviewed_by) + ' · ' + fmtTs(row.reviewed_at) : '<span class="muted">never</span>'}</p>
              </div>
            </div>
          </div>
          <div class="form-group">
            <p class="group-label">02.b / admin notes (private)</p>
            <textarea name="admin_notes" rows="6">${esc(row.admin_notes || '')}</textarea>
          </div>
          <button class="primary-button" type="submit">Save</button>
        </form>
      </div>
    </section>
  `;
  return layout({ title: row.name, body, adminEmail, activeTab: 'list' });
}

function buildRouter(db) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '32kb' }));

  router.get('/login', (req, res) => {
    if (!config.ready) return res.status(503).type('text').send('Admin not configured. Set ADMIN_EMAILS, ADMIN_PASSWORD (>=8 chars), and SESSION_SECRET (>=32 chars).');
    const cookies = parseCookies(req.headers.cookie);
    if (verifySession(cookies[COOKIE_NAME])) return res.redirect('/admin/applications');
    res.set('Cache-Control', 'no-store').type('html').send(renderLogin({ nextPath: req.query.next }));
  });

  router.post('/login', (req, res) => {
    if (!config.ready) return res.status(503).type('text').send('Admin not configured.');
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const next = typeof req.body.next === 'string' && req.body.next.startsWith('/admin/') ? req.body.next : '/admin/applications';
    if (!config.emails.includes(email) || !timingSafeEqualStr(password, config.password)) {
      return res.status(401).type('html').send(renderLogin({ error: 'Invalid email or password.', nextPath: next }));
    }
    setSessionCookie(res, email);
    res.redirect(next);
  });

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.redirect('/admin/login');
  });

  router.get('/', requireAdmin, (req, res) => res.redirect('/admin/applications'));

  const listColumns = 'id, submitted_at, kind, name, email, institution, status';
  const listAll = db.prepare(`SELECT ${listColumns} FROM applications ORDER BY submitted_at DESC`);
  const listByStatus = db.prepare(`SELECT ${listColumns} FROM applications WHERE status = ? ORDER BY submitted_at DESC`);
  const countByStatus = db.prepare('SELECT status, COUNT(*) AS c FROM applications GROUP BY status');
  const countAll = db.prepare('SELECT COUNT(*) AS c FROM applications');
  const getOne = db.prepare('SELECT * FROM applications WHERE id = ?');
  const updateOne = db.prepare('UPDATE applications SET status = ?, admin_notes = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?');

  router.get('/applications', requireAdmin, (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'all';
    const rows = status === 'all' ? listAll.all() : listByStatus.all(status);
    const counts = { all: countAll.get().c };
    for (const s of STATUSES) counts[s] = 0;
    for (const r of countByStatus.all()) counts[r.status] = r.c;
    res.set('Cache-Control', 'no-store').type('html').send(renderList({ adminEmail: req.adminEmail, rows, currentStatus: status, counts }));
  });

  router.get('/applications.csv', requireAdmin, (req, res) => {
    const columns = ['id', 'submitted_at', 'kind', 'name', 'email', 'title', 'institution', 'use_case', 'expected_students', 'institution_budget', 'supporter_interest', 'notes', 'status', 'admin_notes', 'reviewed_at', 'reviewed_by'];
    const rows = db.prepare(`SELECT ${columns.join(', ')} FROM applications ORDER BY submitted_at DESC`).all();
    const csvEscape = (v) => {
      if (v == null) return '';
      const t = String(v);
      return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','))].join('\n') + '\n';
    res.set('Cache-Control', 'no-store').type('text/csv').attachment('educator-applications.csv').send(csv);
  });

  router.get('/applications/:id', requireAdmin, (req, res) => {
    const row = getOne.get(req.params.id);
    if (!row) return res.status(404).type('text').send('Not found.');
    res.set('Cache-Control', 'no-store').type('html').send(renderDetail({ adminEmail: req.adminEmail, row, saved: req.query.saved === '1' }));
  });

  router.post('/applications/:id', requireAdmin, (req, res) => {
    const row = getOne.get(req.params.id);
    if (!row) return res.status(404).type('text').send('Not found.');
    const status = STATUSES.includes(req.body.status) ? req.body.status : row.status || 'pending';
    const adminNotes = String(req.body.admin_notes || '').slice(0, 8000) || null;
    updateOne.run(status, adminNotes, Date.now(), req.adminEmail, row.id);
    res.redirect(`/admin/applications/${encodeURIComponent(row.id)}?saved=1`);
  });

  return router;
}

module.exports = { buildRouter, migrateSchema, requireAdmin, parseCookies, verifySession, signSession, config };
