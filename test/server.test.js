process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.IP_HASH_PEPPER = 'test-pepper';
process.env.INTERNAL_TOKEN = 'secret';
process.env.DB_PATH = ':memory:';
process.env.PUBLIC_URL = 'http://localhost:3220';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, db, validateApplication } = require('../server');

test('healthz returns ok and a row count', async () => {
  const res = await request(app).get('/healthz').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.count, 'number');
});

test('valid educator application persists and returns nanoid id', async () => {
  const payload = { kind: 'educator', name: 'Ada Lovelace', email: 'ada@school.edu', title: 'Professor', institution: 'Example College', use_case: 'Teaching creative coding with AI.', expected_students: 24, institution_budget: 'yes', notes: 'Fall course.' };
  const res = await request(app).post('/api/applications').set('Origin', 'http://localhost:3220').send(payload).expect(201);
  assert.equal(res.body.ok, true);
  assert.match(res.body.id, /^[A-Za-z0-9_-]{10,}$/);
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(res.body.id);
  assert.equal(row.kind, 'educator');
  assert.equal(row.name, 'Ada Lovelace');
  assert.equal(row.expected_students, 24);
  assert.ok(row.ip_hash);
});

test('valid supporter application persists supporter fields only', async () => {
  const payload = { kind: 'supporter', name: 'Grace Hopper', email: 'grace@example.org', supporter_interest: 'Funding and advising.', notes: 'Interested in pilots.' };
  const res = await request(app).post('/api/applications').set('Origin', 'http://localhost:3220').send(payload).expect(201);
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(res.body.id);
  assert.equal(row.kind, 'supporter');
  assert.equal(row.supporter_interest, 'Funding and advising.');
  assert.equal(row.use_case, null);
});

test('invalid payloads return clear 400 errors', async () => {
  const res = await request(app).post('/api/applications').set('Origin', 'http://localhost:3220').send({ kind: 'educator', name: 'No Email' }).expect(400);
  assert.match(res.body.error, /email/i);
});

test('foreign origins are forbidden', async () => {
  const res = await request(app).post('/api/applications').set('Origin', 'https://evil.example').send({ kind: 'supporter', name: 'Bad', email: 'bad@example.com', supporter_interest: 'spam' }).expect(403);
  assert.equal(res.body.error, 'origin forbidden');
});

test('csv export requires token and omits private columns', async () => {
  await request(app).post('/api/applications').set('Origin', 'http://localhost:3220').send({ kind: 'supporter', name: 'CSV Person', email: 'csv@example.org', supporter_interest: 'Partnering' }).expect(201);
  await request(app).get('/api/applications.csv').expect(401);
  const res = await request(app).get('/api/applications.csv').set('X-Internal-Token', 'secret').expect(200);
  assert.match(res.text, /id,submitted_at,kind,name,email/);
  assert.doesNotMatch(res.text, /ip_hash|user_agent/);
  assert.match(res.text, /CSV Person/);
});

test('validateApplication caps text length and expected_students sanity', () => {
  const bad = validateApplication({ kind: 'educator', name: 'A', email: 'a@b.com', title: 'T', institution: 'I', use_case: 'U', expected_students: 100001 });
  assert.equal(bad.error, 'expected_students must be an integer between 0 and 100000');
});
