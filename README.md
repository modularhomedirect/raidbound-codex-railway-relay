# Raidbound Codex Railway Relay

This is a server bridge between the WordPress plugin and a local Unity/Codex machine.

It does **not** clone the Unity repository and does **not** use GitHub for code communication. WordPress uploads a Codex handoff ZIP to this relay, and your local polling agent pulls the job outbound from your Unity machine.

## Deploy on Railway

```bash
cd worker/raidbound-codex-railway-relay
npm install
npm start
```

Railway variables:

```txt
RBOUR_CODEX_RELAY_SECRET=make-a-long-random-secret
MAX_PAYLOAD_MB=120
JOB_TTL_MS=86400000
```

In WordPress, set **Railway relay URL** to your deployed service URL and use the same secret.

## Endpoints

- `POST /v1/codex/jobs` from WordPress
- `GET /v1/codex/jobs/:id` from WordPress polling
- `GET /v1/agent/jobs/next?agent_id=...` from the local agent
- `POST /v1/agent/jobs/:id/status` from the local agent

All private endpoints require `Authorization: Bearer <RBOUR_CODEX_RELAY_SECRET>`.

## Storage note

This lightweight relay stores jobs in memory. That is good enough for a private bridge, but a Railway restart clears queued jobs. For production durability, add Redis/Postgres storage.
