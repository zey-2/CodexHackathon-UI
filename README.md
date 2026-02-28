# Neon Guardian UI

Integrated Neon Guardian frontend + scan backend in one repository.

## Repository Structure

- `web/pages/`
- `web/assets/`
- `web/data/`
- `security-scans/`
- `docs/`

## Prerequisites

- Node.js 18+
- npm
- git
- `OPENAI_API_KEY`

## Run The App (Integrated UI + API)

Run the app from the scan backend folder so UI and `/api/*` are served from one origin.

```bash
cd security-scans
npm install
cp .env.example .env
```

Edit `.env` and set at least:

```bash
OPENAI_API_KEY=your_key_here
CODEX_MODEL=gpt-5.3-codex
MAX_CONCURRENCY=4
PORT=8080
SCAN_MAX_PARALLEL_RUNS=2
SCAN_KEEP_RUNS=30
SCAN_ALLOWED_ROOTS=/home/bitrunner2/CodexHackathon-UI,/tmp
```

Start server:

```bash
npm run serve
```

Open:

- `http://localhost:8080` (auto-redirects to dashboard)

## Run Security Scan From UI

1. Open `http://localhost:8080`.
2. On **Dashboard**, choose source type:
   - `GitHub Repo URL`: enter `https://github.com/org/repo.git`
   - `Server Local Path`: enter absolute path on server host (must be inside `SCAN_ALLOWED_ROOTS`)
3. Click **[ EXECUTE_SCAN ]**.
4. Dashboard status line will poll run state (`queued` / `running` / `completed` / `failed`).
5. On completion, UI auto-opens `Scan Report` for that run (`?runId=...`).

## Run Security Scan From CLI

From `security-scans/`:

Dry run (skill discovery only):

```bash
npm run scan:dry -- --repo-url https://github.com/example/repo.git
```

Execute scan:

```bash
npm run scan -- --repo-url https://github.com/example/repo.git
```

Optional flags:

```bash
npm run scan -- --repo-url https://github.com/example/repo.git --max-concurrency 4 --model gpt-5.3-codex --run-id my-run-id
```

## Output Artifacts

Scan artifacts are written to:

- `security-scans/results/<run-id>/<skill-name>.json`
- `security-scans/results/<run-id>/summary.json`
- `security-scans/results/<run-id>/run-state.json`

Temporary/working content:

- `security-scans/workspaces/`
- `security-scans/skillpacks/`

Retention pruning keeps the newest `SCAN_KEEP_RUNS` runs.

## API Endpoints Used By UI

- `GET /api/dashboard`
- `GET /api/compliance-codex`
- `GET /api/scan-report[?runId=...]`
- `POST /api/scan/prepare-source`
- `POST /api/scan/start`
- `GET /api/scan/status?runId=...`

## Static Preview (No Backend Scan Execution)

For visual-only preview with fallback JSON:

```bash
python3 -m http.server 8080
```

Open:

- `http://localhost:8080/web/pages/dashboard/`
- `http://localhost:8080/web/pages/compliance-codex/`
- `http://localhost:8080/web/pages/scan-report/`
