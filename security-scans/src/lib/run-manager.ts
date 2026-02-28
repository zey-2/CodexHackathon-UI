import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { executeScanRun } from "./scan-runner.js";
import { cloneTargetRepo, ensureScanRoots, makeRunId } from "./repo.js";
import type {
  PreparedSource,
  ScanRunState,
  ScanRunTarget,
  ScanSourceType,
  SkillProgress,
  SkillProgressUpdate
} from "./types.js";

interface RunManagerOptions {
  scansRoot: string;
  allowedLocalRoots: string[];
  maxParallelRuns: number;
  maxConcurrency: number;
  model: string;
  skillpackRepoUrl: string;
  keepRuns: number;
  preparedSourceTtlMs?: number;
}

interface PrepareSourceInput {
  sourceType: ScanSourceType;
  repoUrl?: string;
  localPath?: string;
}

interface StartRunInput {
  sourceId: string;
  sessionId: string;
}

function isGitHubRepoUrl(value: string): boolean {
  const pattern = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?\/?$/i;
  return pattern.test(value.trim());
}

function parseRepoFromGitHubUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return "unknown-repo";
    }
    return parts[1].replace(/\.git$/i, "");
  } catch {
    return "unknown-repo";
  }
}

function makeSourceId(sourceType: ScanSourceType): string {
  const nonce = randomBytes(4).toString("hex");
  return `${sourceType}-${Date.now().toString(36)}-${nonce}`;
}

function makeRunIdWithNonce(): string {
  return `${makeRunId()}-${randomBytes(2).toString("hex")}`;
}

function emptyProgress(): SkillProgress {
  return {
    total: 0,
    completed: 0,
    success: 0,
    failed: 0,
    review: 0
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export class RunManager {
  private readonly options: RunManagerOptions;
  private readonly preparedSources = new Map<string, PreparedSource>();
  private readonly runStates = new Map<string, ScanRunState>();
  private readonly activeRunIds = new Set<string>();
  private readonly rootsPromise: Promise<{
    skillpacksRoot: string;
    workspacesRoot: string;
    resultsRoot: string;
  }>;
  private resolvedAllowedRoots: string[] | null = null;
  private cleanupIntervalHandle: NodeJS.Timeout;

  constructor(options: RunManagerOptions) {
    this.options = {
      ...options,
      preparedSourceTtlMs: options.preparedSourceTtlMs ?? 30 * 60 * 1000
    };
    this.rootsPromise = ensureScanRoots(this.options.scansRoot);

    this.cleanupIntervalHandle = setInterval(() => {
      void this.cleanupExpiredPreparedSources();
    }, 60_000);
    this.cleanupIntervalHandle.unref();
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupIntervalHandle);
  }

  private async getRoots(): Promise<{
    skillpacksRoot: string;
    workspacesRoot: string;
    resultsRoot: string;
  }> {
    return this.rootsPromise;
  }

  private async getAllowedRoots(): Promise<string[]> {
    if (this.resolvedAllowedRoots) {
      return this.resolvedAllowedRoots;
    }

    const resolvedRoots: string[] = [];
    for (const candidate of this.options.allowedLocalRoots) {
      const trimmed = String(candidate || "").trim();
      if (!trimmed) {
        continue;
      }

      try {
        const resolved = await realpath(path.resolve(trimmed));
        resolvedRoots.push(resolved);
      } catch {
        // Ignore roots that do not resolve.
      }
    }

    this.resolvedAllowedRoots = [...new Set(resolvedRoots)];
    return this.resolvedAllowedRoots;
  }

  private async assertAllowedLocalPath(inputPath: string): Promise<string> {
    const absolutePath = path.resolve(inputPath);
    const currentStat = await stat(absolutePath);
    if (!currentStat.isDirectory()) {
      throw new Error(`Local scan path must be a directory: ${absolutePath}`);
    }

    const resolvedPath = await realpath(absolutePath);
    const allowedRoots = await this.getAllowedRoots();

    if (allowedRoots.length === 0) {
      return resolvedPath;
    }

    const allowed = allowedRoots.some((root) => {
      const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
      return resolvedPath === root || resolvedPath.startsWith(normalizedRoot);
    });

    if (!allowed) {
      throw new Error(`Local path is outside SCAN_ALLOWED_ROOTS: ${resolvedPath}`);
    }

    return resolvedPath;
  }

  private getRunResultDir(roots: { resultsRoot: string }, runId: string): string {
    return path.join(roots.resultsRoot, runId);
  }

  private getRunStatePath(runState: ScanRunState): string {
    return path.join(runState.resultDir, "run-state.json");
  }

  private async persistRunState(runState: ScanRunState): Promise<void> {
    await mkdir(runState.resultDir, { recursive: true });
    await writeFile(this.getRunStatePath(runState), `${JSON.stringify(runState, null, 2)}\n`, "utf8");
  }

  private applyProgress(runState: ScanRunState, progress: SkillProgressUpdate): void {
    runState.progress = {
      total: progress.total,
      completed: progress.completed,
      success: progress.success,
      failed: progress.failed,
      review: progress.review
    };
    runState.updatedAt = nowIso();
  }

  async prepareSource(input: PrepareSourceInput): Promise<PreparedSource> {
    await this.cleanupExpiredPreparedSources();
    const roots = await this.getRoots();

    if (input.sourceType === "github") {
      const repoUrl = String(input.repoUrl || "").trim();
      if (!isGitHubRepoUrl(repoUrl)) {
        throw new Error("GitHub URL must match https://github.com/org/repo(.git). format.");
      }

      const sourceId = makeSourceId("github");
      const preparedRoot = path.join(roots.workspacesRoot, "prepared-sources", sourceId);
      const preparedRepoPath = path.join(preparedRoot, "target-repo");
      const repo = parseRepoFromGitHubUrl(repoUrl);

      await mkdir(preparedRoot, { recursive: true });

      await cloneTargetRepo(repoUrl, preparedRepoPath);

      const now = Date.now();
      const preparedSource: PreparedSource = {
        sourceId,
        sourceType: "github",
        repo,
        scanPath: preparedRepoPath,
        repoUrl,
        preparedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (this.options.preparedSourceTtlMs || 0)).toISOString(),
        used: false
      };

      this.preparedSources.set(sourceId, preparedSource);
      return preparedSource;
    }

    const localPath = String(input.localPath || "").trim();
    if (!localPath) {
      throw new Error("Local scans require localPath.");
    }

    const validatedPath = await this.assertAllowedLocalPath(localPath);
    const sourceId = makeSourceId("local");
    const now = Date.now();

    const preparedSource: PreparedSource = {
      sourceId,
      sourceType: "local",
      repo: path.basename(validatedPath) || "local-repo",
      scanPath: validatedPath,
      repoUrl: `local://${validatedPath}`,
      preparedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (this.options.preparedSourceTtlMs || 0)).toISOString(),
      used: false
    };

    this.preparedSources.set(sourceId, preparedSource);
    return preparedSource;
  }

  async startRun(input: StartRunInput): Promise<ScanRunState> {
    await this.cleanupExpiredPreparedSources();
    const preparedSource = this.preparedSources.get(input.sourceId);

    if (!preparedSource) {
      throw new Error("Unknown or expired sourceId.");
    }

    if (preparedSource.used) {
      throw new Error("sourceId has already been used. Prepare a new source.");
    }

    if (this.activeRunIds.size >= this.options.maxParallelRuns) {
      throw new Error("Scan concurrency limit reached.");
    }

    preparedSource.used = true;
    const roots = await this.getRoots();
    const runId = makeRunIdWithNonce();
    const resultDir = this.getRunResultDir(roots, runId);

    const runState: ScanRunState = {
      runId,
      sessionId: String(input.sessionId || "").trim() || "SESSION-UNKNOWN",
      sourceType: preparedSource.sourceType,
      repo: preparedSource.repo,
      scanPath: preparedSource.scanPath,
      state: "queued",
      progress: emptyProgress(),
      resultDir,
      summaryPath: path.join(resultDir, "summary.json"),
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
      error: null,
      updatedAt: nowIso()
    };

    this.runStates.set(runId, runState);
    await this.persistRunState(runState);

    queueMicrotask(() => {
      void this.executeRun(runId, preparedSource).catch(() => {
        // executeRun persists failures into run-state.
      });
    });

    return runState;
  }

  private async executeRun(runId: string, preparedSource: PreparedSource): Promise<void> {
    const runState = this.runStates.get(runId);
    if (!runState) {
      return;
    }

    this.activeRunIds.add(runId);

    runState.state = "running";
    runState.startedAt = nowIso();
    runState.updatedAt = nowIso();
    await this.persistRunState(runState);

    try {
      const target: ScanRunTarget = {
        sourceType: preparedSource.sourceType,
        repo: preparedSource.repo,
        repoUrl: preparedSource.sourceType === "github" ? preparedSource.repoUrl : undefined,
        scanPath: preparedSource.scanPath
      };

      const result = await executeScanRun(
        {
          runId,
          maxConcurrency: this.options.maxConcurrency,
          model: this.options.model,
          skillpackRepoUrl: this.options.skillpackRepoUrl,
          scansRoot: this.options.scansRoot,
          target
        },
        {
          onProgress: async (progress) => {
            const current = this.runStates.get(runId);
            if (!current) {
              return;
            }

            this.applyProgress(current, progress);
            await this.persistRunState(current);
          }
        }
      );

      const current = this.runStates.get(runId);
      if (!current) {
        return;
      }

      current.state = "completed";
      current.endedAt = nowIso();
      current.updatedAt = nowIso();
      current.summaryPath = result.summaryPath;
      current.progress.total = result.summary.skillsDiscovered;
      current.progress.completed = result.summary.skillsExecuted;
      current.progress.success = result.summary.results.filter((item) => {
        if (item.status !== "success") {
          return false;
        }
        const staticStatus = String(item.response?.static_status || item.response?.assessment || "").toLowerCase();
        if (staticStatus === "implemented") {
          return true;
        }
        if (staticStatus === "missing" || staticStatus === "partial") {
          return false;
        }

        const evalStatus = String(item.response?.status || "").toLowerCase();
        return evalStatus === "pass";
      }).length;
      current.progress.review = result.summary.results.filter((item) => {
        const staticStatus = String(item.response?.static_status || item.response?.assessment || "").toLowerCase();
        return item.status === "success" && staticStatus === "partial";
      }).length;
      current.progress.failed = Math.max(0, current.progress.completed - current.progress.success - current.progress.review);
      await this.persistRunState(current);
    } catch (error) {
      const current = this.runStates.get(runId);
      if (current) {
        current.state = "failed";
        current.endedAt = nowIso();
        current.updatedAt = nowIso();
        current.error = error instanceof Error ? error.message : String(error);
        await this.persistRunState(current);
      }
    } finally {
      this.activeRunIds.delete(runId);
      this.preparedSources.delete(preparedSource.sourceId);

      if (preparedSource.sourceType === "github") {
        const preparedRoot = path.dirname(preparedSource.scanPath);
        await rm(preparedRoot, { recursive: true, force: true });
      }

      await this.pruneOldRuns();
    }
  }

  async getRunState(runId: string): Promise<ScanRunState | null> {
    const inMemory = this.runStates.get(runId);
    if (inMemory) {
      return inMemory;
    }

    const roots = await this.getRoots();
    const runStatePath = path.join(roots.resultsRoot, runId, "run-state.json");

    try {
      const raw = await readFile(runStatePath, "utf8");
      const parsed = JSON.parse(raw) as ScanRunState;
      this.runStates.set(runId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  private async getRunArtifactMtime(resultDir: string): Promise<number | null> {
    const entries = await readdir(resultDir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      return null;
    }

    const jsonFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".json"));

    if (jsonFiles.length === 0) {
      return null;
    }

    let latestMtime = -1;
    for (const fileName of jsonFiles) {
      const filePath = path.join(resultDir, fileName);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) {
        continue;
      }
      latestMtime = Math.max(latestMtime, fileStat.mtimeMs);
    }

    return latestMtime >= 0 ? latestMtime : null;
  }

  async resolvePreferredRunId(preferredRunId?: string): Promise<string | null> {
    const roots = await this.getRoots();

    if (preferredRunId) {
      const state = await this.getRunState(preferredRunId);
      if (state) {
        return preferredRunId;
      }

      const preferredDir = path.join(roots.resultsRoot, preferredRunId);
      const preferredMtime = await this.getRunArtifactMtime(preferredDir);
      if (preferredMtime !== null) {
        return preferredRunId;
      }
    }

    const runDirs = await readdir(roots.resultsRoot, { withFileTypes: true });
    const candidates: Array<{ runId: string; mtimeMs: number }> = [];

    for (const entry of runDirs) {
      if (!entry.isDirectory()) {
        continue;
      }

      const resultDir = path.join(roots.resultsRoot, entry.name);
      const mtimeMs = await this.getRunArtifactMtime(resultDir);
      if (mtimeMs !== null) {
        candidates.push({ runId: entry.name, mtimeMs });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].runId;
  }

  private async cleanupExpiredPreparedSources(): Promise<void> {
    const now = Date.now();
    const roots = await this.getRoots();

    for (const [sourceId, source] of this.preparedSources.entries()) {
      const expiryMs = Date.parse(source.expiresAt);
      if (Number.isFinite(expiryMs) && expiryMs > now) {
        continue;
      }

      this.preparedSources.delete(sourceId);

      if (source.sourceType === "github") {
        const preparedRoot = path.dirname(source.scanPath);
        await rm(preparedRoot, { recursive: true, force: true });
      }
    }

    await mkdir(path.join(roots.workspacesRoot, "prepared-sources"), {
      recursive: true
    });
  }

  private async pruneOldRuns(): Promise<void> {
    const roots = await this.getRoots();
    const keepCount = Math.max(1, this.options.keepRuns);

    const entries = await readdir(roots.resultsRoot, { withFileTypes: true });
    const runs: Array<{ runId: string; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const runPath = path.join(roots.resultsRoot, entry.name);
      const runStat = await stat(runPath);
      runs.push({
        runId: entry.name,
        mtimeMs: runStat.mtimeMs
      });
    }

    runs.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const toDelete = runs.slice(keepCount);
    for (const item of toDelete) {
      await rm(path.join(roots.resultsRoot, item.runId), {
        recursive: true,
        force: true
      });
      await rm(path.join(roots.workspacesRoot, item.runId), {
        recursive: true,
        force: true
      });
      this.runStates.delete(item.runId);
    }
  }
}
