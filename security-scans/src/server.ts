import "dotenv/config";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RunManager } from "./lib/run-manager.js";
import { loadRunSummary, mapSummaryToScanReport } from "./lib/report-mapper.js";

const DEFAULT_MODEL = process.env.CODEX_MODEL || "codex-mini-latest";
const DEFAULT_MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || "4");
const DEFAULT_SKILLPACK_REPO_URL =
  "https://github.com/zey-2/security_skillpacks.git";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scansRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(scansRoot, "..");
const webRoot = path.resolve(repoRoot, "web");
const dataRoot = path.join(webRoot, "data");
const resultsRoot = path.join(scansRoot, "results");

const port = Number(process.env.PORT || "8080");
const maxParallelRuns = Number(process.env.SCAN_MAX_PARALLEL_RUNS || "2");
const keepRuns = Number(process.env.SCAN_KEEP_RUNS || "30");

const allowedRootDefaults = [repoRoot, "/tmp"];
const allowedLocalRoots = (process.env.SCAN_ALLOWED_ROOTS || allowedRootDefaults.join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const runManager = new RunManager({
  scansRoot,
  allowedLocalRoots,
  maxParallelRuns: Number.isFinite(maxParallelRuns) && maxParallelRuns > 0 ? maxParallelRuns : 2,
  maxConcurrency: Number.isFinite(DEFAULT_MAX_CONCURRENCY) && DEFAULT_MAX_CONCURRENCY > 0 ? DEFAULT_MAX_CONCURRENCY : 4,
  model: DEFAULT_MODEL,
  skillpackRepoUrl: process.env.SKILLPACK_REPO_URL || DEFAULT_SKILLPACK_REPO_URL,
  keepRuns: Number.isFinite(keepRuns) && keepRuns > 0 ? keepRuns : 30
});

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const total = chunks.reduce((sum, entry) => sum + entry.length, 0);
    if (total > 2 * 1024 * 1024) {
      throw new Error("Request payload too large.");
    }
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object.");
  }

  return parsed as Record<string, unknown>;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".js") {
    return "application/javascript; charset=utf-8";
  }
  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }
  if (ext === ".json") {
    return "application/json; charset=utf-8";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  if (ext === ".ico") {
    return "image/x-icon";
  }
  if (ext === ".woff") {
    return "font/woff";
  }
  if (ext === ".woff2") {
    return "font/woff2";
  }
  if (ext === ".txt") {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const currentStat = await stat(filePath);
    return currentStat.isFile();
  } catch {
    return false;
  }
}

async function resolveStaticFile(requestPath: string): Promise<string | null> {
  let pathname = decodeURIComponent(requestPath);
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const normalizedPath = path.normalize(pathname).replace(/^([.][.][\/])+/, "");
  const directPath = path.join(webRoot, normalizedPath);

  const safeRoot = webRoot.endsWith(path.sep) ? webRoot : `${webRoot}${path.sep}`;
  const safeDirect = path.resolve(directPath);
  if (!(safeDirect === webRoot || safeDirect.startsWith(safeRoot))) {
    return null;
  }

  if (await fileExists(safeDirect)) {
    return safeDirect;
  }

  if (!path.extname(safeDirect)) {
    const indexPath = path.join(safeDirect, "index.html");
    if (await fileExists(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

async function serveStatic(res: ServerResponse, requestPath: string): Promise<void> {
  const staticFile = await resolveStaticFile(requestPath);
  if (!staticFile) {
    json(res, 404, {
      error: "Not found"
    });
    return;
  }

  const body = await readFile(staticFile);
  res.writeHead(200, {
    "Content-Type": getMimeType(staticFile),
    "Cache-Control": "no-store",
    "Content-Length": body.length
  });
  res.end(body);
}

async function readJsonDataFile(fileName: string): Promise<Record<string, unknown>> {
  const targetPath = path.join(dataRoot, fileName);
  const raw = await readFile(targetPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Unexpected JSON shape in ${fileName}`);
  }

  return parsed as Record<string, unknown>;
}

function mapErrorToStatus(error: unknown): number {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes("concurrency limit")) {
    return 429;
  }
  if (message.includes("outside scan_allowed_roots")) {
    return 403;
  }
  if (message.includes("already been used")) {
    return 409;
  }
  if (message.includes("expired sourceid") || message.includes("unknown")) {
    return 404;
  }
  if (message.includes("must") || message.includes("require") || message.includes("invalid")) {
    return 400;
  }

  return 500;
}

function badMethod(res: ServerResponse): void {
  json(res, 405, {
    error: "Method not allowed"
  });
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const host = req.headers.host || `localhost:${port}`;
    const parsedUrl = new URL(req.url || "/", `http://${host}`);
    const pathname = parsedUrl.pathname;

    if (pathname === "/api/dashboard") {
      if (method !== "GET") {
        badMethod(res);
        return;
      }

      const dashboard = await readJsonDataFile("dashboard.json");
      json(res, 200, dashboard);
      return;
    }

    if (pathname === "/api/compliance-codex") {
      if (method !== "GET") {
        badMethod(res);
        return;
      }

      const codex = await readJsonDataFile("compliance-codex.json");
      json(res, 200, codex);
      return;
    }

    if (pathname === "/api/scan/prepare-source") {
      if (method !== "POST") {
        badMethod(res);
        return;
      }

      try {
        const body = await readJsonBody(req);
        const sourceType = String(body.sourceType || "").toLowerCase();

        if (sourceType !== "github" && sourceType !== "local") {
          json(res, 400, {
            error: "sourceType must be 'github' or 'local'."
          });
          return;
        }

        const prepared = await runManager.prepareSource({
          sourceType,
          repoUrl: typeof body.repoUrl === "string" ? body.repoUrl : "",
          localPath: typeof body.localPath === "string" ? body.localPath : ""
        });

        json(res, 200, {
          sourceId: prepared.sourceId,
          sourceType: prepared.sourceType,
          repo: prepared.repo,
          scanPath: prepared.scanPath,
          preparedAt: prepared.preparedAt,
          expiresAt: prepared.expiresAt
        });
      } catch (error) {
        json(res, mapErrorToStatus(error), {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (pathname === "/api/scan/start") {
      if (method !== "POST") {
        badMethod(res);
        return;
      }

      try {
        const body = await readJsonBody(req);
        const sourceId = String(body.sourceId || "").trim();
        const sessionId = String(body.sessionId || "").trim();

        if (!sourceId) {
          json(res, 400, {
            error: "sourceId is required."
          });
          return;
        }

        const runState = await runManager.startRun({
          sourceId,
          sessionId
        });

        json(res, 202, {
          runId: runState.runId,
          status: runState.state,
          statusUrl: `/api/scan/status?runId=${encodeURIComponent(runState.runId)}`,
          reportUrl: `/api/scan-report?runId=${encodeURIComponent(runState.runId)}`
        });
      } catch (error) {
        json(res, mapErrorToStatus(error), {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (pathname === "/api/scan/status") {
      if (method !== "GET") {
        badMethod(res);
        return;
      }

      const runId = String(parsedUrl.searchParams.get("runId") || "").trim();
      if (!runId) {
        json(res, 400, {
          error: "runId query parameter is required."
        });
        return;
      }

      const state = await runManager.getRunState(runId);
      if (!state) {
        json(res, 404, {
          error: `Run not found: ${runId}`
        });
        return;
      }

      json(res, 200, {
        runId: state.runId,
        sessionId: state.sessionId,
        sourceType: state.sourceType,
        repo: state.repo,
        scanPath: state.scanPath,
        state: state.state,
        progress: state.progress,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        error: state.error,
        reportUrl: `/api/scan-report?runId=${encodeURIComponent(runId)}`
      });
      return;
    }

    if (pathname === "/api/scan-report") {
      if (method !== "GET") {
        badMethod(res);
        return;
      }

      const preferredRunId = String(parsedUrl.searchParams.get("runId") || "").trim() || undefined;
      const resolvedRunId = await runManager.resolvePreferredRunId(preferredRunId);

      if (!resolvedRunId) {
        const fallback = await readJsonDataFile("scan-report.json");
        json(res, 200, fallback);
        return;
      }

      const summary = await loadRunSummary(resultsRoot, resolvedRunId);
      if (!summary) {
        const fallback = await readJsonDataFile("scan-report.json");
        json(res, 200, {
          ...fallback,
          reportId: resolvedRunId,
          status: "NO_SUMMARY",
          severity: "warning",
          result: "PENDING_SUMMARY",
          action: "WAIT_OR_RETRY",
          fail: 0,
          success: 0,
          passRate: 0
        });
        return;
      }

      const runState = await runManager.getRunState(resolvedRunId);
      const reportPayload = mapSummaryToScanReport(summary, runState);
      json(res, 200, reportPayload);
      return;
    }

    await serveStatic(res, pathname);
  } catch (error) {
    json(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, () => {
  console.log(`Neon Guardian server listening on http://localhost:${port}`);
  console.log(`- web root: ${webRoot}`);
  console.log(`- scans root: ${scansRoot}`);
  console.log(`- allowed local roots: ${allowedLocalRoots.join(", ")}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void runManager.close().finally(() => {
      server.close(() => {
        process.exit(0);
      });
    });
  });
}
