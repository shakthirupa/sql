// Runs inside a worker thread so a runaway query can be killed by timeout.
const { parentPort } = require('worker_threads');
const Database = require('better-sqlite3');

function exec(db, sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('Only SELECT / WITH queries are allowed');
  const st = db.prepare(sql.trim().replace(/;+\s*$/, '')); // throws on multiple statements
  if (!st.reader) throw new Error('Query must return rows');
  const cols = st.columns().map(c => c.name);
  return { cols, rows: st.raw().all().slice(0, 1000) };
}

parentPort.on('message', ({ setup, user, solution }) => {
  const out = {};
  let db;
  try { db = new Database(':memory:'); db.exec(setup); db.pragma('query_only = ON'); }
  catch (e) { return parentPort.postMessage({ setupError: e.message }); }
  if (user != null) { try { out.got = exec(db, user); } catch (e) { out.userError = e.message; } }
  if (solution != null) { try { out.want = exec(db, solution); } catch (e) { out.solutionError = e.message; } }
  parentPort.postMessage(out);
});
