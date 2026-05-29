# Raidbound Codex Railway Relay v1.1.1

Small authenticated relay used by WordPress and the local Unity machine.

## v1.1.1 changes

- Persists jobs to disk so Railway restarts do not erase queued/claimed/running job records.
- Requeues stale `claimed`/`running` jobs after `CLAIM_STALE_MS` with a default of 2 hours.
- Uses `RBOUR_RELAY_DATA_DIR`, `RAILWAY_VOLUME_MOUNT_PATH`, or `./data` for `codex-jobs.json`.
- `/health` reports `supports_persistence`, `supports_stale_requeue`, and `data_dir`.

## Environment

```bash
RBOUR_CODEX_RELAY_SECRET=your-long-secret
RBOUR_RELAY_DATA_DIR=/data   # recommended when Railway volume is mounted
MAX_PAYLOAD_MB=120
JOB_TTL_MS=86400000
CLAIM_STALE_MS=7200000
```

## Endpoints

- `GET /health`
- `POST /v1/codex/jobs`
- `GET /v1/codex/jobs/:id`
- `GET /v1/agent/jobs/next?agent_id=...`
- `POST /v1/agent/jobs/:id/status`

Keep the relay secret outside source control and configure it as a Railway variable.


## v1.1.2 context-safe update

- Nested error/status objects are serialized as readable JSON instead of `[object Object]`.
- Jobs marked with context-window failures get `meta.context_window_failure=true` for the WordPress console.
