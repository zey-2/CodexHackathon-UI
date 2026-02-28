# Security Scans (Codex SDK)

This module provides:

- CLI scan orchestration (`npm run scan`, `npm run scan:dry`)
- Integrated API server for the Neon Guardian UI (`npm run serve`)

## What It Does

- Clones security skillpacks from `https://github.com/zey-2/security_skillpacks.git`
- Discovers code-eval skills only (`*-code-static-eval`, `*-code-evaluation`)
- Prepares scan sources (GitHub clone or server-local path)
- Executes each skill in bounded parallelism
- Writes one JSON result per skill, plus `summary.json` and `run-state.json`
- Serves run status and scan report payloads for the UI

## Layout

- `skillpacks/` cloned skillpack repository
- `workspaces/` prepared sources and run workspaces
- `results/` run-specific outputs and summaries

## Prerequisites

- Node.js 18+
- npm
- git
- `OPENAI_API_KEY` set in shell or `.env`

## Setup

```bash
cd security-scans
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY
```

## Run Integrated Server

```bash
npm run serve
```

Open: `http://localhost:8080`

### Environment Variables

- `PORT` (default `8080`)
- `OPENAI_API_KEY` (required for execution)
- `CODEX_MODEL` (default `codex-mini-latest`)
- `MAX_CONCURRENCY` (default `4`)
- `SCAN_MAX_PARALLEL_RUNS` (default `2`)
- `SCAN_ALLOWED_ROOTS` (comma-separated absolute paths)
- `SCAN_KEEP_RUNS` (default `30`)
- `SKILLPACK_REPO_URL` (optional override)

## API Contract

### `POST /api/scan/prepare-source`

Request:

```json
{
  "sourceType": "github",
  "repoUrl": "https://github.com/org/repo.git"
}
```

or

```json
{
  "sourceType": "local",
  "localPath": "/absolute/path/on/server"
}
```

Response:

```json
{
  "sourceId": "...",
  "sourceType": "github",
  "repo": "repo",
  "scanPath": "/...",
  "preparedAt": "...",
  "expiresAt": "..."
}
```

### `POST /api/scan/start`

Request:

```json
{
  "sourceId": "...",
  "sessionId": "NG-..."
}
```

Response:

```json
{
  "runId": "...",
  "status": "queued",
  "statusUrl": "/api/scan/status?runId=...",
  "reportUrl": "/api/scan-report?runId=..."
}
```

### `GET /api/scan/status?runId=...`

Returns run lifecycle state and progress counters.

### `GET /api/scan-report?runId=...`

Returns normalized payload consumed by `web/pages/scan-report`.

## CLI Usage

### Dry Run

```bash
npm run scan:dry -- --repo-url https://github.com/example/repo.git
```

### Execute Scan

```bash
npm run scan -- --repo-url https://github.com/example/repo.git
```

Optional flags:

- `--max-concurrency 4`
- `--model gpt-5.3-codex`
- `--run-id my-custom-run-id`
- `--skillpack-url https://github.com/zey-2/security_skillpacks.git`

## Output

Artifacts are written to:

- `results/<run-id>/<skill-name>.json`
- `results/<run-id>/summary.json`
- `results/<run-id>/run-state.json`

Retention pruning keeps the newest `SCAN_KEEP_RUNS` runs.
