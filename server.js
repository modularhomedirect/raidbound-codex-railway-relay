'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SECRET = process.env.RBOUR_CODEX_RELAY_SECRET || process.env.RAIDBOUND_CODEX_RELAY_SECRET || '';
const MAX_PAYLOAD_MB = parseInt(process.env.MAX_PAYLOAD_MB || '120', 10);
const JOB_TTL_MS = parseInt(process.env.JOB_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const CLAIM_STALE_MS = parseInt(process.env.CLAIM_STALE_MS || String(2 * 60 * 60 * 1000), 10);
const DATA_DIR = path.resolve(process.env.RBOUR_RELAY_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), 'data'));
const JOBS_FILE = path.join(DATA_DIR, 'codex-jobs.json');
const jobs = new Map();

function now() { return new Date().toISOString(); }
function id() { return 'rbcr_' + Date.now() + '_' + crypto.randomBytes(5).toString('hex'); }
function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJsonAtomic(file, value) {
  mkdirp(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.jobs) ? parsed.jobs : []);
    for (const job of list) {
      if (!job || !job.job_id) continue;
      jobs.set(job.job_id, job);
    }
  } catch (err) {
    console.error('Could not load persisted relay jobs:', err.message);
  }
}
function persistJobs() {
  try {
    writeJsonAtomic(JOBS_FILE, { saved_utc: now(), jobs: Array.from(jobs.values()) });
  } catch (err) {
    console.error('Could not persist relay jobs:', err.message);
  }
}
function stringifyForRelay(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (Array.isArray(value)) return value.map(stringifyForRelay).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const headline = [value.message, value.error, value.code].filter(Boolean).map(String).join(' | ');
    try {
      const json = JSON.stringify(value, null, 2);
      return headline && !json.includes(headline) ? headline + '\n' + json : json;
    } catch (_) { return headline || Object.prototype.toString.call(value); }
  }
  return String(value);
}
function safeTail(value, max = 16000) {
  value = stringifyForRelay(value);
  return value.length > max ? value.slice(value.length - max) : value;
}
function looksLikeContextWindowError(value) {
  const text = stringifyForRelay(value).toLowerCase();
  return !!text && (text.includes('ran out of room in the model') || text.includes('context window') || text.includes('start a new thread') || text.includes('clear earlier history') || text.includes('maximum context') || text.includes('context length') || text.includes('too many tokens') || text.includes('token limit exceeded') || text.includes('input is too large'));
}
function publicJob(job) {
  return {
    job_id: job.job_id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    created_utc: job.created_utc,
    updated_utc: job.updated_utc,
    claimed_utc: job.claimed_utc || null,
    finished_utc: job.finished_utc || null,
    source: job.source || {},
    config: job.config || {},
    handoff: {
      filename: job.handoff && job.handoff.filename,
      url: job.handoff && job.handoff.url,
      count: job.handoff && job.handoff.count,
      has_zip: !!(job.handoff && job.handoff.zip_base64)
    },
    agent_id: job.agent_id || '',
    phase: job.phase || '',
    log_tail: safeTail([job.final_text, job.log_tail, job.stdout_tail, job.stderr_tail].filter(Boolean).join('\n')),
    stdout_tail: safeTail(job.stdout_tail || ''),
    stderr_tail: safeTail(job.stderr_tail || ''),
    final_text: safeTail(job.final_text || '', 40000),
    error: safeTail(job.error || '', 8000),
    meta: job.meta || {}
  };
}
function auth(req, res, next) {
  if (!SECRET) return res.status(500).json({ error: 'secret_missing', message: 'RBOUR_CODEX_RELAY_SECRET is not set.' });
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Missing bearer secret.' });
  const a = Buffer.from(token);
  const b = Buffer.from(SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized', message: 'Invalid bearer secret.' });
  next();
}
function purgeOldJobs() {
  const nowMs = Date.now();
  const cutoff = nowMs - JOB_TTL_MS;
  const staleCutoff = nowMs - CLAIM_STALE_MS;
  let changed = false;
  for (const [jobId, job] of jobs) {
    if (Date.parse(job.created_utc) < cutoff) { jobs.delete(jobId); changed = true; continue; }
    if (['claimed', 'running'].includes(job.status)) {
      const lastTouch = Date.parse(job.updated_utc || job.claimed_utc || job.created_utc);
      if (Number.isFinite(lastTouch) && lastTouch < staleCutoff) {
        job.status = 'queued';
        job.progress = 5;
        job.message = 'Requeued after stale claim/run state. Waiting for local Unity Codex agent to poll.';
        job.phase = 'queued';
        job.agent_id = '';
        job.claimed_utc = null;
        job.updated_utc = now();
        job.meta = { ...(job.meta || {}), requeued_after_stale_utc: job.updated_utc };
        changed = true;
      }
    }
  }
  if (changed) persistJobs();
}

const app = express();
app.use(express.json({ limit: `${MAX_PAYLOAD_MB}mb` }));
app.get('/health', (req, res) => res.json({ ok: true, service: 'raidbound-codex-railway-relay', version: '1.1.1', secret_configured: !!SECRET, queued_jobs: jobs.size, supports_meta: true, supports_paused: true, supports_final_text: true, supports_persistence: true, supports_stale_requeue: true, data_dir: DATA_DIR }));

app.post('/v1/codex/jobs', auth, (req, res) => {
  purgeOldJobs();
  const handoff = req.body && req.body.handoff;
  if (!handoff || !handoff.zip_base64) return res.status(400).json({ error: 'bad_request', message: 'handoff.zip_base64 is required.' });
  const job = {
    job_id: id(),
    status: 'queued',
    progress: 5,
    message: 'Queued on Railway relay. Waiting for local Unity Codex agent to poll.',
    created_utc: now(),
    updated_utc: now(),
    source: req.body.source || {},
    config: req.body.config || {},
    handoff,
    log_tail: '',
    stdout_tail: '',
    stderr_tail: '',
    final_text: '',
    phase: 'queued',
    error: ''
  };
  jobs.set(job.job_id, job);
  persistJobs();
  res.json({ job: publicJob(job) });
});

app.get('/v1/codex/jobs/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found', message: 'Job not found or expired.' });
  res.json({ job: publicJob(job) });
});

app.get('/v1/agent/jobs/next', auth, (req, res) => {
  purgeOldJobs();
  const agentId = String(req.query.agent_id || 'local-agent');
  for (const job of jobs.values()) {
    if (job.status === 'queued') {
      job.status = 'claimed';
      job.progress = 15;
      job.message = 'Claimed by local Codex agent.';
      job.agent_id = agentId;
      job.claimed_utc = now();
      job.updated_utc = now();
      persistJobs();
      return res.json({ job });
    }
  }
  res.status(204).send('');
});

app.post('/v1/agent/jobs/:id/status', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found', message: 'Job not found or expired.' });
  const body = req.body || {};
  if (body.status) job.status = String(body.status);
  if (body.phase) job.phase = String(body.phase);
  if (body.progress != null) job.progress = Math.max(0, Math.min(100, parseInt(body.progress, 10) || 0));
  if (body.message) job.message = safeTail(body.message, 8000);
  if (body.log_tail) job.log_tail = safeTail(body.log_tail);
  if (body.stdout_tail) job.stdout_tail = safeTail(body.stdout_tail);
  if (body.stderr_tail) job.stderr_tail = safeTail(body.stderr_tail);
  if (body.final_text) job.final_text = safeTail(body.final_text, 40000);
  if (body.error) job.error = safeTail(body.error, 8000);
  if (looksLikeContextWindowError([job.error, job.message, job.log_tail, job.stdout_tail, job.stderr_tail, job.final_text])) {
    job.meta = { ...(job.meta || {}), context_window_failure: true };
  }
  if (body.meta && typeof body.meta === 'object') job.meta = body.meta;
  if (job.status === 'complete' || job.status === 'error' || job.status === 'failed' || job.status === 'paused') job.finished_utc = now();
  job.updated_utc = now();
  persistJobs();
  res.json({ job: publicJob(job) });
});

loadJobs();
app.listen(PORT, () => {
  console.log(`Raidbound Codex Railway Relay listening on ${PORT}`);
  console.log(`Persisting relay jobs to ${JOBS_FILE}`);
});
