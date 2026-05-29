# Raidbound Codex Railway Relay v1.1.4

Small authenticated Railway relay used by WordPress and the local Unity/Codex machine.

## v1.1.4 changes

- Preserves and exposes the selected Codex CLI model as `codex_model`.
- Accepts model values from `config.codex_model`, `config.codexModel`, `codex_model`, or `codexModel`.
- Adds `/health` flag `supports_codex_model_config=true` so WordPress/local tooling can confirm the relay supports model pass-through.
- Includes `codex_model` in normal job status and fast `/ping` status.
- Merges agent `meta` updates instead of replacing the whole metadata object.
- Keeps the v1.1.3 split handoff storage behavior so large ZIP payloads stay out of the persisted job index.

The relay itself does **not** run Codex. It stores the job and passes the selected model to the local agent. The local agent is the piece that runs Codex CLI with `codex exec --model ...`.

## v1.1.3 changes

- Uses split handoff ZIP storage under `handoffs/` instead of keeping large base64 ZIP payloads inside `codex-jobs.json`.
- Adds fast/lite status responses and `/v1/codex/jobs/:id/ping`.
- Reports `supports_fast_status` and `supports_split_handoff_storage` from `/health`.

## v1.1.2 context-safe update

- Nested error/status objects are serialized as readable JSON instead of `[object Object]`.
- Jobs marked with context-window failures get `meta.context_window_failure=true` for the WordPress console.

## v1.1.1 persistence update

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
- `GET /v1/codex/jobs/:id/ping`
- `GET /v1/agent/jobs/next?agent_id=...`
- `POST /v1/agent/jobs/:id/status`

Keep the relay secret outside source control and configure it as a Railway variable.
