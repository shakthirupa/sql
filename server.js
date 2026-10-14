const express = require('express');
const Database = require('better-sqlite3');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || '';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const store = new Database(path.join(DATA, 'app.db'));
store.exec(`CREATE TABLE IF NOT EXISTS problems(
  id TEXT PRIMARY KEY, title TEXT, level TEXT, description TEXT, schema_sql TEXT,
  solution TEXT, ordered INTEGER DEFAULT 0, hide_tests INTEGER DEFAULT 1,
  tests TEXT DEFAULT '[]', created INTEGER, check_cols INTEGER DEFAULT 0)`);
try { store.exec('ALTER TABLE problems ADD COLUMN check_cols INTEGER DEFAULT 0'); } catch {}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- sandboxed execution ---------- */
function runJob(job, ms = 3000) {
  return new Promise(resolve => {
    const w = new Worker(path.join(__dirname, 'runner.js'));
    const t = setTimeout(() => { w.terminate(); resolve({ userError: 'Time limit exceeded (3s)', solutionError: 'Time limit exceeded' }); }, ms);
    w.once('message', m => { clearTimeout(t); w.terminate(); resolve(m); });
    w.once('error', e => { clearTimeout(t); resolve({ setupError: e.message }); });
    w.postMessage(job);
  });
}
const norm = v => v == null ? null : typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : String(v);
function compare(got, want, ordered, checkCols) {
  if (checkCols && got.cols.map(c => c.toLowerCase()).join('|') !== want.cols.map(c => c.toLowerCase()).join('|'))
    return `Column names must be exactly: ${want.cols.join(' | ')} (yours: ${got.cols.join(' | ') || 'none'})`;
  if (got.rows.length !== want.rows.length) return `Expected ${want.rows.length} row(s), got ${got.rows.length}`;
  if (want.rows.length && got.cols.length !== want.cols.length) return `Expected ${want.cols.length} column(s), got ${got.cols.length}`;
  let a = got.rows.map(r => JSON.stringify(r.map(norm))), b = want.rows.map(r => JSON.stringify(r.map(norm)));
  if (!ordered) { a.sort(); b.sort(); }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return ordered ? `Row ${i + 1} differs (order matters)` : 'Result does not match expected output';
  return null;
}
const asObjs = r => r.rows.slice(0, 20).map(row => Object.fromEntries(r.cols.map((c, i) => [c, row[i]])));

/* ---------- auth ---------- */
const admin = (req, res, next) => {
  if (!ADMIN) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set on the server' });
  if (req.get('x-admin-key') !== ADMIN) return res.status(401).json({ error: 'Wrong admin password' });
  next();
};
app.post('/api/admin/login', admin, (_, res) => res.json({ ok: true }));

/* ---------- public API (friend) ---------- */
app.get('/api/problems', (_, res) =>
  res.json(store.prepare('SELECT id,title,level FROM problems ORDER BY created').all()));

app.get('/api/problems/:id', (req, res) => {
  const p = store.prepare('SELECT * FROM problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const tests = JSON.parse(p.tests);
  res.json({ id: p.id, title: p.title, level: p.level, description: p.description,
    sample: tests[0]?.setup || p.schema_sql, testCount: tests.length, ordered: !!p.ordered, checkCols: !!p.check_cols });
});

// Returns expected output for test 1 (runs the reference solution)
app.get('/api/problems/:id/expected', async (req, res) => {
  const p = store.prepare('SELECT * FROM problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const tests = JSON.parse(p.tests);
  if (!tests[0]) return res.json({ rows: [] });
  const r = await runJob({ setup: tests[0].setup, solution: p.solution });
  res.json({ rows: r.want ? asObjs(r.want) : [] });
});

// Returns all rows from all tables in the sample setup (for display)
app.post('/api/preview-tables', async (req, res) => {
  const { id } = req.body || {};
  const p = store.prepare('SELECT * FROM problems WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const tests = JSON.parse(p.tests);
  const setup = tests[0]?.setup || p.schema_sql;
  // Extract table names from CREATE TABLE statements
  const names = [...setup.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi)].map(m => m[1]);
  const results = [];
  for (const name of names) {
    const r = await runJob({ setup, user: `SELECT * FROM ${name}` });
    if (!r.userError) results.push({ name, rows: asObjs(r.got) });
  }
  res.json({ tables: results });
});

app.post('/api/run', async (req, res) => {
  const { id, sql, mode } = req.body || {};
  const p = store.prepare('SELECT * FROM problems WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (typeof sql !== 'string' || sql.length > 5000) return res.status(400).json({ error: 'Bad query' });
  const tests = JSON.parse(p.tests);
  if (mode === 'sample') {
    const r = await runJob({ setup: tests[0].setup, user: sql });
    return res.json(r.userError ? { error: r.userError } : { output: asObjs(r.got) });
  }
  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const hidden = i > 0 && !!p.hide_tests;
    const r = await runJob({ setup: tests[i].setup, user: sql, solution: p.solution });
    let msg = r.userError || r.solutionError || r.setupError || (r.got && r.want ? compare(r.got, r.want, !!p.ordered, !!p.check_cols) : 'Unknown error');
    results.push({ n: i + 1, name: hidden && msg ? 'Hidden case' : tests[i].name, hidden, pass: !msg,
      message: msg && (hidden && !r.userError ? 'Wrong answer on a hidden case' : msg),
      got: msg && !hidden && r.got ? asObjs(r.got) : undefined });
  }
  res.json({ passed: results.filter(x => x.pass).length, total: results.length, results });
});

/* ---------- author API ---------- */
app.get('/api/admin/problems/:id', admin, (req, res) => {
  const p = store.prepare('SELECT * FROM problems WHERE id=?').get(req.params.id);
  p ? res.json({ ...p, tests: JSON.parse(p.tests) }) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/admin/problems', admin, (req, res) => {
  const b = req.body, id = b.id || Date.now().toString(36);
  store.prepare(`INSERT INTO problems(id,title,level,description,schema_sql,solution,ordered,hide_tests,tests,created,check_cols)
    VALUES(@id,@title,@level,@description,@schema_sql,@solution,@ordered,@hide_tests,@tests,@created,@check_cols)
    ON CONFLICT(id) DO UPDATE SET title=@title,level=@level,description=@description,schema_sql=@schema_sql,
    solution=@solution,ordered=@ordered,hide_tests=@hide_tests,tests=@tests,check_cols=@check_cols`).run({
    id, title: b.title, level: b.level || '', description: b.description || '', schema_sql: b.schema_sql || '',
    solution: b.solution, ordered: b.ordered ? 1 : 0, hide_tests: b.hide_tests ? 1 : 0,
    tests: JSON.stringify(b.tests || []), created: Date.now(), check_cols: b.check_cols ? 1 : 0 });
  res.json({ id });
});
app.delete('/api/admin/problems/:id', admin, (req, res) => {
  store.prepare('DELETE FROM problems WHERE id=?').run(req.params.id); res.json({ ok: true });
});

/* ---------- AI test-case generator ---------- */
async function askLLM(prompt) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set on the server');
  const r = await fetch((process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({ model: MODEL, temperature: 0.6, max_tokens: 8000,
      response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Groq API error');
  const text = j.choices?.[0]?.message?.content || '';
  try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
  catch { throw new Error('The model returned invalid JSON, click Generate again'); }
}

async function genTests({ title, description, schema_sql, solution, count = 6 }) {
  const ai = await askLLM(`You are an adversarial SQL test designer. Write the TOUGHEST possible test datasets for this SQLite problem, to catch every plausible wrong answer.

PROBLEM: ${title}
${description}

SCHEMA (every test's setup must begin with exactly these statements):
${schema_sql}

REFERENCE SOLUTION:
${solution}

Produce ${count} test cases. Each "setup" is SQLite SQL: the schema followed by INSERTs (max ~30 rows). Cover edge cases relevant to THIS problem, such as: empty tables, a single row, NULLs in every nullable column, duplicate rows, ties at boundaries, off-by-one values equal to thresholds, case/whitespace differences in strings, negative or zero numbers, orphan or missing join matches, multiple matches per key, dates at boundaries, and data where a naive approach (wrong JOIN type, missing DISTINCT, WHERE vs HAVING, COUNT(*) vs COUNT(col), NULL comparisons) gives a different answer. Test 1 must be small and friendly, as the sample shown to students. Data must be deterministic. Use single quotes for all string literals (double quotes are rejected).
Also write 6 plausible WRONG queries that students commonly write (valid SQLite SELECTs).

Reply with JSON only, no markdown:
{"tests":[{"name":"short name","targets":"the trap it sets","setup":"..."}],"wrong_queries":["SELECT ..."]}`);
  const out = [], rejected = [];
  for (const t of ai.tests || []) {
    const r = await runJob({ setup: t.setup, solution });
    if (r.setupError || r.solutionError) { rejected.push({ name: t.name, error: r.setupError || r.solutionError }); continue; }
    let kills = 0;
    for (const w of (ai.wrong_queries || []).slice(0, 8)) {
      const x = await runJob({ setup: t.setup, user: w, solution });
      if (x.got && x.want ? compare(x.got, x.want, false) : x.userError) kills++;
    }
    out.push({ name: t.name, targets: t.targets, setup: t.setup, catches: kills, expected_rows: r.want.rows.length, want: r.want });
  }
  return { tests: out, rejected, wrongQueries: (ai.wrong_queries || []).length };
}

// Mode 1: author gives schema + solution, AI writes tests
app.post('/api/admin/ai-tests', admin, async (req, res) => {
  try {
    if (!req.body.schema_sql || !req.body.solution) return res.status(400).json({ error: 'Schema and reference solution are required' });
    const g = await genTests(req.body);
    res.json({ ...g, tests: g.tests.map(({ want, ...t }) => t) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mode 2: author pastes the question in ANY format (exam boilerplate, schema hints, required columns...)
// Extract CREATE TABLE + INSERT blocks embedded in raw question text
function extractEmbeddedSchema(text) {
  const matches = text.match(/(?:CREATE\s+TABLE[\s\S]*?;\s*)+(?:INSERT\s+INTO[\s\S]*?;\s*)*/gi);
  if (!matches) return '';
  return matches.join('\n').trim();
}

const draftPrompt = (text, existingSchema, problem) => `You are helping a SQL instructor. They pasted the text below. It may contain exam boilerplate, the real question, required output columns, and possibly embedded SQL (CREATE TABLE / INSERT statements).

PASTED TEXT:
"""${text}"""
${existingSchema ? `
SCHEMA (use this EXACTLY as-is — do NOT invent or modify tables, do NOT add extra tables):
${existingSchema}
` : ''}
Do all of this:
1. "question": rewrite as a clean student-facing question. Remove boilerplate and question numbers, keep required-output-columns and schema hints.
2. "schema_sql": ${existingSchema ? 'Return the provided schema UNCHANGED (only CREATE TABLE statements, no INSERTs).' : 'CREATE TABLE statements (SQLite). If a schema hint is given, use EXACTLY those table/column names. Otherwise design a minimal schema.'}
3. "output_columns": required output column names in order (empty array if none specified).
4. "solution": ONE correct SELECT/WITH query. Column names must match output_columns if specified.
5. "ordered": true only if the question demands a specific row order.
6. "title", "level" (Easy|Medium|Hard), "assumptions".
${problem ? '\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ' + problem + '\nFix it.\n' : ''}
Reply with JSON only: {"title":"","level":"","question":"","schema_sql":"","output_columns":[],"solution":"","ordered":false,"assumptions":""}`;

app.post('/api/admin/ai-draft', admin, async (req, res) => {
  try {
    const { description, count = 6 } = req.body;
    let existingSchema = (req.body.schema_sql || '').trim();
    if (!description || description.trim().length < 10) return res.status(400).json({ error: 'Paste the question first' });
    // Auto-extract schema embedded in the question text if schema field is blank
    if (!existingSchema) existingSchema = extractEmbeddedSchema(description);
    let d, problem = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      d = await askLLM(draftPrompt(description, existingSchema, problem));
      problem = '';
      if (!d.schema_sql || !d.solution) { problem = 'schema_sql and solution are required'; continue; }
      // Always enforce the extracted/provided schema — strip any INSERTs the AI may have added
      if (existingSchema) {
        const createOnly = existingSchema.match(/CREATE\s+TABLE[\s\S]*?;/gi);
        d.schema_sql = createOnly ? createOnly.join('\n') : existingSchema;
      }
      const chk = await runJob({ setup: d.schema_sql, solution: d.solution });
      if (chk.setupError || chk.solutionError) { problem = 'It failed in SQLite: ' + (chk.setupError || chk.solutionError); continue; }
      const want = (d.output_columns || []).map(c => String(c).toLowerCase()).join('|');
      if (want && chk.want.cols.map(c => c.toLowerCase()).join('|') !== want) {
        problem = `Solution columns were (${chk.want.cols.join(', ')}) but required columns are (${d.output_columns.join(', ')})`; continue; }
      break;
    }
    if (problem) throw new Error('The AI could not produce a valid draft (' + problem + '). Click again or rephrase.');
    const question = d.question || description;
    const g = await genTests({ title: d.title, description: question, schema_sql: d.schema_sql, solution: d.solution, count });
    res.json({ title: d.title, level: d.level, question, schema_sql: d.schema_sql, solution: d.solution, ordered: !!d.ordered,
      check_cols: (d.output_columns || []).length > 0, assumptions: d.assumptions || '',
      sample: g.tests[0] ? asObjs(g.tests[0].want) : [],
      tests: g.tests.map(({ want, ...t }) => t), rejected: g.rejected, wrongQueries: g.wrongQueries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`SQL Arena running on http://localhost:${PORT}`));
