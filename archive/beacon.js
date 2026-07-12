/**
 * beacon — zero-dep Node client for the script control plane.
 *
 * Copy this file into any project (or symlink it). It reports to the beacon
 * ingest API so the script shows up in the registry with live heartbeats, logs,
 * and Telegram alerts on start/finish/fail — and a "stalled" alert if the host
 * dies mid-run.
 *
 *   const beacon = require('./beacon');
 *
 *   // one-liner: registers, runs fn, auto-heartbeats, catches crashes, finishes
 *   beacon.wrap({
 *     slug: 'allabolag',
 *     name: 'Allabolag extractor',
 *     path: __filename,                 // absolute path, so you never lose it
 *     data_store_kind: 'local_file',
 *     data_location: '/home/philip/…/out/allabolag.jsonl',
 *   }, async (run) => {
 *     run.log('info', 'starting');
 *     run.heartbeat({ page: 3 });       // progress payload (optional)
 *     run.rows(1203);                   // report a row count for the finish alert
 *   });
 *
 * Env: BEACON_URL (e.g. https://scriptbox-mcp.hostbun.cc), BEACON_KEY (x-api-key).
 * If BEACON_URL is unset, beacon is a no-op — scripts run fine without it.
 */
'use strict';
const os = require('os');

const URL = process.env.BEACON_URL || '';
const KEY = process.env.BEACON_KEY || process.env.MCP_API_KEY || '';
const HEARTBEAT_MS = Number(process.env.BEACON_HEARTBEAT_MS) || 30000;

async function post(path, body) {
  if (!URL) return null;
  try {
    const res = await fetch(`${URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(8000),
    });
    return await res.json().catch(() => ({}));
  } catch { return null; } // beacon must never break the script
}

async function register(def) {
  if (!def || !def.slug) throw new Error('beacon: slug required');
  await post('/v1/register', { host: os.hostname(), ...def });
  return def.slug;
}

class Run {
  constructor(slug, id) {
    this.slug = slug; this.id = id; this._rows = null; this._buf = []; this._closed = false;
    this._hb = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    if (this._hb.unref) this._hb.unref();
    this._flush = setInterval(() => this._flushLogs(), 3000);
    if (this._flush.unref) this._flush.unref();
  }
  heartbeat(meta) { if (this.id) post(`/v1/runs/${this.id}/heartbeat`, { meta }); }
  log(level, msg) {
    this._buf.push({ level, msg: String(msg) });
    if (this._buf.length >= 50) this._flushLogs();
  }
  rows(n) { this._rows = n; }
  async _flushLogs() {
    if (!this.id || !this._buf.length) return;
    const lines = this._buf.splice(0, 200);
    await post(`/v1/runs/${this.id}/logs`, { lines });
  }
  async finish(status, error, exit_code) {
    if (this._closed) return; this._closed = true;
    clearInterval(this._hb); clearInterval(this._flush);
    await this._flushLogs();
    await post(`/v1/runs/${this.id}/finish`, { status, error: error ? String(error.stack || error.message || error) : null, exit_code, rows_affected: this._rows });
  }
}

/** Low-level: begin a run yourself (remember to call run.finish()). */
async function start(slugOrDef) {
  const def = typeof slugOrDef === 'string' ? { slug: slugOrDef } : slugOrDef;
  const slug = await register(def);
  const r = await post('/v1/runs', { slug, host: os.hostname(), pid: process.pid });
  return new Run(slug, r && r.run_id);
}

/** High-level: register + run fn + auto-heartbeat + crash-catch + finish. */
async function wrap(slugOrDef, fn) {
  const run = await start(slugOrDef);
  const onFatal = (err) => { run.finish('failed', err).finally(() => process.exit(1)); };
  process.once('uncaughtException', onFatal);
  process.once('unhandledRejection', onFatal);
  try {
    const result = await fn(run);
    if (result && typeof result === 'object' && 'rows' in result && run._rows == null) run.rows(result.rows);
    await run.finish('completed');
    return result;
  } catch (err) {
    await run.finish('failed', err);
    throw err;
  } finally {
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onFatal);
  }
}

module.exports = { register, start, wrap, Run };
