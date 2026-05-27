'use strict';

const express = require('express');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SECRET = process.env.RBOUR_CODEX_RELAY_SECRET || process.env.RAIDBOUND_CODEX_RELAY_SECRET || '';
const MAX_PAYLOAD_MB = parseInt(process.env.MAX_PAYLOAD_MB || '120', 10);
const JOB_TTL_MS = parseInt(process.env.JOB_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const jobs = new Map();

function now() { return new Date().toISOString(); }
function id() { return 'rbcr_' + Date.now() + '_' + crypto.randomBytes(5).toString('hex'); }
function safeTail(value, max = 16000) {
  if (Array.isArray(value)) value = value.join('\n');
  value = String(value || '');
  return value.length > max ? value.slice(value.length - max) : value;
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
    log_tail: safeTail(job.log_tail || ''),
    error: job.error || ''
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
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [jobId, job] of jobs) {
    if (Date.parse(job.created_utc) < cutoff) jobs.delete(jobId);
  }
}

const app = express();
app.use(express.json({ limit: `${MAX_PAYLOAD_MB}mb` }));
app.get('/health', (req, res) => res.json({ ok: true, service: 'raidbound-codex-railway-relay', secret_configured: !!SECRET, queued_jobs: jobs.size }));

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
    error: ''
  };
  jobs.set(job.job_id, job);
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
  if (body.progress != null) job.progress = Math.max(0, Math.min(100, parseInt(body.progress, 10) || 0));
  if (body.message) job.message = String(body.message);
  if (body.log_tail || body.stdout_tail || body.stderr_tail) job.log_tail = safeTail([body.log_tail, body.stdout_tail, body.stderr_tail].filter(Boolean).join('\n'));
  if (body.error) job.error = String(body.error);
  if (job.status === 'complete' || job.status === 'error' || job.status === 'failed') job.finished_utc = now();
  job.updated_utc = now();
  res.json({ job: publicJob(job) });
});

app.listen(PORT, () => {
  console.log(`Raidbound Codex Railway Relay listening on ${PORT}`);
});
