require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 3220);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';
const IP_HASH_PEPPER = (process.env.IP_HASH_PEPPER || '').trim();

if (!IP_HASH_PEPPER) {
  throw new Error('IP_HASH_PEPPER is required');
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'applications.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    submitted_at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('educator','supporter')),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    title TEXT,
    institution TEXT,
    use_case TEXT,
    expected_students INTEGER,
    institution_budget TEXT,
    supporter_interest TEXT,
    notes TEXT,
    user_agent TEXT,
    ip_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_applications_submitted_at ON applications(submitted_at);
`);

function smtpConfigComplete() {
  return ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'NOTIFY_TO'].every((key) => (process.env[key] || '').trim());
}
const SMTP_READY = smtpConfigComplete();
let mailer = null;
if (SMTP_READY) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
} else if (process.env.NODE_ENV !== 'test') {
  console.log('SMTP not configured — skipping notification');
}

const allowedOrigins = new Set(['https://educator-list.ijglabs.ai', 'http://localhost:3220', PUBLIC_URL]);
const writeCors = cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.has(origin)) return cb(null, true);
    const error = new Error('origin forbidden');
    error.status = 403;
    return cb(error);
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Internal-Token'],
  maxAge: 86400
});

app.options('/api/applications', writeCors);
app.use('/api/applications', writeCors);
app.use(express.json({ limit: '16kb', type: 'application/json' }));
app.use(express.static(PUBLIC_DIR));

function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

function id() {
  return crypto.randomBytes(12).toString('base64url');
}

function trimString(value, field, max = 4000) {
  if (value == null) return '';
  if (typeof value !== 'string') throw validationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw validationError(`${field} must be ${max} characters or less`);
  return trimmed;
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function requireField(payload, field) {
  const value = trimString(payload[field], field);
  if (!value) throw validationError(`${field} is required`);
  return value;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  if (!EMAIL_RE.test(email)) throw validationError('email must be valid');
  return email;
}

function normalizeExpectedStudents(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100000) {
    throw validationError('expected_students must be an integer between 0 and 100000');
  }
  return value;
}

function normalizeBudget(raw) {
  const value = trimString(raw, 'institution_budget');
  if (!value) return null;
  if (!['yes', 'no', 'unsure', 'prefer not to say'].includes(value)) {
    throw validationError('institution_budget must be yes, no, unsure, prefer not to say, or blank');
  }
  return value;
}

function validateApplication(body = {}) {
  try {
    const kind = trimString(body.kind, 'kind');
    if (!['educator', 'supporter'].includes(kind)) throw validationError('kind must be educator or supporter');
    const base = {
      kind,
      name: requireField(body, 'name'),
      email: validateEmail(requireField(body, 'email')),
      title: null,
      institution: null,
      use_case: null,
      expected_students: null,
      institution_budget: null,
      supporter_interest: null,
      notes: trimString(body.notes, 'notes') || null
    };
    if (kind === 'educator') {
      base.title = requireField(body, 'title');
      base.institution = requireField(body, 'institution');
      base.use_case = requireField(body, 'use_case');
      base.expected_students = normalizeExpectedStudents(body.expected_students);
      base.institution_budget = normalizeBudget(body.institution_budget);
    } else {
      base.supporter_interest = requireField(body, 'supporter_interest');
    }
    return { value: base };
  } catch (error) {
    return { error: error.message, status: error.status || 400 };
  }
}

function hashIp(req) {
  const raw = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || req.ip || '';
  return crypto.createHash('sha256').update(`${IP_HASH_PEPPER}:${raw}`).digest('hex');
}

const insertApplication = db.prepare(`
  INSERT INTO applications (id, submitted_at, kind, name, email, title, institution, use_case, expected_students, institution_budget, supporter_interest, notes, user_agent, ip_hash)
  VALUES (@id, @submitted_at, @kind, @name, @email, @title, @institution, @use_case, @expected_students, @institution_budget, @supporter_interest, @notes, @user_agent, @ip_hash)
`);

function notifyAsync(row) {
  if (!mailer) return;
  const lines = [
    `New ${row.kind} submission`,
    `Name: ${row.name}`,
    `Email: ${row.email}`,
    row.title ? `Title: ${row.title}` : null,
    row.institution ? `Institution: ${row.institution}` : null,
    row.use_case ? `Use case: ${row.use_case}` : null,
    row.supporter_interest ? `Supporter interest: ${row.supporter_interest}` : null,
    row.expected_students != null ? `Expected students: ${row.expected_students}` : null,
    row.institution_budget ? `Budget: ${row.institution_budget}` : null,
    row.notes ? `Notes: ${row.notes}` : null,
    `ID: ${row.id}`
  ].filter(Boolean).join('\n');
  setImmediate(() => {
    mailer.sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.NOTIFY_TO,
      subject: `IJG Labs educator list: ${row.kind} submission`,
      text: lines
    }).catch((error) => console.error('notification email failed', error));
  });
}

app.get('/healthz', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS count FROM applications').get().count;
  res.json({ ok: true, count });
});

app.post('/api/applications', (req, res, next) => {
  try {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Content-Type application/json is required' });
    const result = validateApplication(req.body);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    const row = {
      id: id(),
      submitted_at: Date.now(),
      ...result.value,
      user_agent: trimString(req.get('User-Agent') || '', 'user_agent', 1000) || null,
      ip_hash: hashIp(req)
    };
    insertApplication.run(row);
    notifyAsync(row);
    res.status(201).json({ ok: true, id: row.id });
  } catch (error) {
    next(error);
  }
});

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

app.get('/api/applications.csv', (req, res) => {
  noStore(res);
  if (!INTERNAL_TOKEN) return res.status(503).json({ error: 'export disabled' });
  if ((req.get('X-Internal-Token') || '') !== INTERNAL_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const columns = ['id', 'submitted_at', 'kind', 'name', 'email', 'title', 'institution', 'use_case', 'expected_students', 'institution_budget', 'supporter_interest', 'notes'];
  const rows = db.prepare(`SELECT ${columns.join(', ')} FROM applications ORDER BY submitted_at DESC`).all();
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))].join('\n') + '\n';
  res.type('text/csv').send(csv);
});

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message = status === 403 && err.message === 'origin forbidden' ? 'origin forbidden' : status === 413 ? 'payload too large' : status === 400 ? err.message : 'request failed';
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ijglabs-educator-list listening on ${PORT}`);
  });
}

module.exports = { app, db, validateApplication };
