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
const HANDOFF_DIR = path.join(DATA_DIR, 'handoffs');
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
function handoffPathFor(jobId) {
  return path.join(HANDOFF_DIR, jobId + '.zip.b64');
}
function writeHandoffZip(jobId, zipBase64) {
  mkdirp(HANDOFF_DIR);
  const file = handoffPathFor(jobId);
  fs.writeFileSync(file, String(zipBase64 || ''), 'utf8');
  return file;
}
function readHandoffZip(job) {
  if (job && job.handoff && job.handoff.zip_base64) return job.handoff.zip_base64;
  const zipFile = job && job.handoff && (job.handoff.zip_file || job.handoff.zip_path);
  if (zipFile && fs.existsSync(zipFile)) return fs.readFileSync(zipFile, 'utf8');
  const fallback = job && job.job_id ? handoffPathFor(job.job_id) : '';
  if (fallback && fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf8');
  return '';
}
function jobForPersistence(job) {
  const copy = { ...job, handoff: { ...(job.handoff || {}) } };
  if (copy.handoff.zip_base64) delete copy.handoff.zip_base64;
  if (job.job_id && !copy.handoff.zip_file) copy.handoff.zip_file = handoffPathFor(job.job_id);
  copy.handoff.has_zip = !!readHandoffZip(job);
  return copy;
}
function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.jobs) ? parsed.jobs : []);
    for (const job of list) {
      if (!job || !job.job_id) continue;
      if (job.handoff && job.handoff.zip_base64) {
        const file = writeHandoffZip(job.job_id, job.handoff.zip_base64);
        delete job.handoff.zip_base64;
        job.handoff.zip_file = file;
        job.handoff.has_zip = true;
      }
      jobs.set(job.job_id, job);
    }
  } catch (err) {
    console.error('Could not load persisted relay jobs:', err.message);
  }
}
function persistJobs() {
  try {
    writeJsonAtomic(JOBS_FILE, { saved_utc: now(), jobs: Array.from(jobs.values()).map(jobForPersistence) });
  } catch (err) {
    console.error('Could not persist relay jobs:', err.message);
  }
}
function compactJob(job) {
  return {
    job_id: job.job_id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    created_utc: job.created_utc,
    updated_utc: job.updated_utc,
    claimed_utc: job.claimed_utc || null,
    finished_utc: job.finished_utc || null,
    agent_id: job.agent_id || '',
    phase: job.phase || '',
    source: job.source || {},
    config: job.config || {},
    handoff: {
      filename: job.handoff && job.handoff.filename,
      url: job.handoff && job.handoff.url,
      count: job.handoff && job.handoff.count,
      has_zip: !!readHandoffZip(job)
    },
    log_tail: safeTail([job.log_tail, job.stdout_tail, job.stderr_tail].filter(Boolean).join('\n'), 6000),
    stdout_tail: safeTail(job.stdout_tail || '', 3000),
    stderr_tail: safeTail(job.stderr_tail || '', 3000),
    final_text: ['complete', 'completed', 'success', 'error', 'failed', 'paused'].includes(String(job.status || '').toLowerCase()) ? safeTail(job.final_text || '', 12000) : '',
    error: safeTail(job.error || '', 4000),
    meta: job.meta || {}
  };
}
function publicJob(job, opts = {}) {
  if (opts.lite) return compactJob(job);
  return {
    ...compactJob(job),
    log_tail: safeTail([job.final_text, job.log_tail, job.stdout_tail, job.stderr_tail].filter(Boolean).join('\n'), 24000),
    stdout_tail: safeTail(job.stdout_tail || '', 12000),
    stderr_tail: safeTail(job.stderr_tail || '', 12000),
    final_text: safeTail(job.final_text || '', 40000),
    error: safeTail(job.error || '', 8000)
  };
}
function jobForAgent(job) {
  return {
    ...job,
    handoff: {
      ...(job.handoff || {}),
      zip_base64: readHandoffZip(job)
    }
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
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'raidbound-codex-railway-relay',
  version: '1.1.3',
  secret_configured: !!SECRET,
  queued_jobs: jobs.size,
  supports_meta: true,
  supports_paused: true,
  supports_final_text: true,
  supports_persistence: true,
  supports_stale_requeue: true,
  supports_fast_status: true,
  supports_split_handoff_storage: true,
  data_dir: DATA_DIR
}));

app.post('/v1/codex/jobs', auth, (req, res) => {
  purgeOldJobs();
  const handoff = req.body && req.body.handoff;
  if (!handoff || !handoff.zip_base64) return res.status(400).json({ error: 'bad_request', message: 'handoff.zip_base64 is required.' });
  const jobId = id();
  const zipFile = writeHandoffZip(jobId, handoff.zip_base64);
  const storedHandoff = { ...handoff, zip_file: zipFile, has_zip: true };
  delete storedHandoff.zip_base64;
  const job = {
    job_id: jobId,
    status: 'queued',
    progress: 5,
    message: 'Queued on Railway relay. Waiting for local Unity Codex agent to poll.',
    created_utc: now(),
    updated_utc: now(),
    source: req.body.source || {},
    config: req.body.config || {},
    handoff: storedHandoff,
    log_tail: '',
    stdout_tail: '',
    stderr_tail: '',
    final_text: '',
    phase: 'queued',
    error: ''
  };
  jobs.set(job.job_id, job);
  persistJobs();
  res.json({ job: publicJob(job, { lite: true }) });
});

app.get('/v1/codex/jobs/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found', message: 'Job not found or expired.' });
  const lite = String(req.query.lite || '').toLowerCase() === '1' || String(req.query.lite || '').toLowerCase() === 'true';
  res.json({ job: publicJob(job, { lite }) });
});

app.get('/v1/codex/jobs/:id/ping', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found', message: 'Job not found or expired.' });
  res.json({ job: {
    job_id: job.job_id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    phase: job.phase || '',
    updated_utc: job.updated_utc,
    finished_utc: job.finished_utc || null
  }});
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
      const agentJob = jobForAgent(job);
      if (!agentJob.handoff.zip_base64) {
        job.status = 'error';
        job.progress = 100;
        job.message = 'Relay could not load the stored handoff ZIP for the local agent.';
        job.error = job.message;
        job.finished_utc = now();
        job.updated_utc = now();
        persistJobs();
        return res.status(500).json({ error: 'handoff_missing', message: job.message });
      }
      return res.json({ job: agentJob });
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
  if (body.message) job.message = safeTail(body.message, 4000);
  if (body.log_tail) job.log_tail = safeTail(body.log_tail, 8000);
  if (body.stdout_tail) job.stdout_tail = safeTail(body.stdout_tail, 8000);
  if (body.stderr_tail) job.stderr_tail = safeTail(body.stderr_tail, 8000);
  if (body.final_text) job.final_text = safeTail(body.final_text, 40000);
  if (body.error) job.error = safeTail(body.error, 4000);
  if (looksLikeContextWindowError([job.error, job.message, job.log_tail, job.stdout_tail, job.stderr_tail, job.final_text])) {
    job.meta = { ...(job.meta || {}), context_window_failure: true };
  }
  if (body.meta && typeof body.meta === 'object') job.meta = body.meta;
  if (job.status === 'complete' || job.status === 'error' || job.status === 'failed' || job.status === 'paused') job.finished_utc = now();
  job.updated_utc = now();
  persistJobs();
  res.json({ job: publicJob(job, { lite: true }) });
});

loadJobs();
app.listen(PORT, () => {
  console.log(`Raidbound Codex Railway Relay listening on ${PORT}`);
  console.log(`Persisting relay jobs to ${JOBS_FILE}`);
  console.log(`Persisting handoff zip payloads to ${HANDOFF_DIR}`);
});
