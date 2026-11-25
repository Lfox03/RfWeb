# Pointage RFID — RFID Attendance System

RFID attendance system with a French UI: a Node/Express + SQLite server that reads a USB
card reader, plus a React dashboard for staff and a dedicated kiosk screen for students.

| Workspace | Stack |
|---|---|
| `server/` | TypeScript, Express 5, better-sqlite3 (SQLite/WAL), node-hid, ws — REST API + WebSocket hub + scheduler |
| `client/` | React 19, Vite 8, react-router-dom 7 — dashboard (admin/teacher) + `/kiosk` screen |
| `rfid/` | Hardware layer (`rfidApi.js` / `rfidWorker.js`), reached only through the `RfidReader` interface |

## Prerequisites

- **Node.js ≥ 22** (CI tests 22, 24 and 26 on Ubuntu + 22 on Windows) and npm ≥ 10
- The USB RFID reader is optional: run with `RFID_DISABLED=1` for development without hardware
- Native modules (`better-sqlite3`, `node-hid`) ship prebuilt binaries in their npm packages;
  if your npm blocks install scripts, no approval is needed (no compilation required)

## Getting started

```bash
npm install
cp .env.example .env      # optional — defaults are sensible for development
npm run db:seed           # demo data + the admin account
npm run dev               # server on :3000 + Vite dev server on :5173
```

Open **http://localhost:5173** in development (Vite proxies `/api` and `/ws` to the server).

- Login: `admin` / `admin` (override with `SEED_ADMIN_PASSWORD`).
- Demo cards presented in tests: `9000001` (Ada Lovelace), `9000002` (Alan Turing).
- Roles: `admin` > `teacher` > `kiosk` (read-only). The `/kiosk` page opens **without login**
  when accessed from the server machine itself (loopback).

## Scripts (run from the repo root)

| Command | Purpose |
|---|---|
| `npm run dev` | Server (`tsx watch`) + Vite dev server, concurrently |
| `npm run build` | Server → `dist/server/`, client → `client/dist/` |
| `npm start` | Production: serves the built client (+ SPA fallback) and the API on `HTTP_PORT` |
| `npm run typecheck` | Server typecheck (the client is typechecked inside `npm run build`) |
| `npm run db:migrate` | Apply SQLite migrations (they also run automatically at every boot) |
| `npm run db:seed` | Seed demo data + admin account (never runs automatically) |
| `npm run db:verify` | Database verification suite (~97 checks) |
| `npm run api:verify` | Full API verification suite (~550 checks) — this project's test suite |
| `npm run test:client` | Client unit tests for the pure helpers (`node --test`, typechecked first) |

There is no test/lint framework: the two `verify` CLIs **are** the server test suite;
`npm run test:client` adds unit tests for the client's pure helper functions using Node's
built-in test runner (still no framework). The verify CLIs run on a fresh temporary SQLite
database with an emulated reader and ephemeral ports, so they never touch your real
`attendance.db`.

## Configuration

All configuration is environment variables; `.env.example` documents them and
`server/src/config/env.ts` is the source of truth for every variable and default.
Key points:

- `.env` is loaded **only when the server runs from the repo root**.
- The SQLite database path `./attendance.db` is **CWD-relative** (override with `DB_PATH`).
- `RFID_DISABLED=1` disables all USB access (offline mode).
- `SEED_ADMIN_PASSWORD` sets the seeded admin password — **change it on any real installation**.

## Important notes

- `attendance.db` (+ `-wal` / `-shm`) is **live state — never delete or reset it**.
- A `scheduled` session **will auto-start itself** on a running server once its time window
  contains now; cancel it if you want the server to stay idle.
- The standalone WebSocket transport uses `WS_PORT` (default 8080) and can clash with local
  tooling; the client always uses `/ws` on the HTTP port instead, so a failed 8080 bind at
  boot is a non-fatal warning.

## Architecture

Deep architecture documentation (session state machine, series recurrence, scheduler, auth,
scan pipeline, WebSocket events, database layout, API conventions) lives in
[AGENTS.md](AGENTS.md).

## CI

[GitHub Actions](.github/workflows/ci.yml) runs the full chain — `npm ci` → `typecheck` →
`test:client` → `db:verify` → `api:verify` → `build` → a boot smoke test of the built server
(`GET /api/health`) — on Ubuntu with Node 22 / 24 / 26, and again on Windows with Node 22
(the deployment target: Windows path/WAL handling and win32 native prebuilds get exercised).
