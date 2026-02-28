import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import pLimit from "p-limit";

import { createCodexClient, runSkillThread } from "./codex.js";
import { cloneTargetRepo, ensureScanRoots } from "./repo.js";
import { discoverCodeEvalSkills, syncSkillpackRepo } from "./skills.js";
import type {
  ScanRunConfig,
  ScanRunDryPlan,
  ScanRunExecutionResult,
  ScanRunRequest,
  ScanSummary,
  SkillDescriptor,
  SkillProgressUpdate,
  SkillRunResult
} from "./types.js";

const DEFAULT_SKILLPACK_REPO_URL =
  "https://github.com/zey-2/security_skillpacks.git";

function isRetryableError(errorMessage: string | null): boolean {
  if (!errorMessage) {
    return false;
  }

  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("rate") ||
    normalized.includes("429") ||
    normalized.includes("timeout") ||
    normalized.includes("temporar") ||
    normalized.includes("econnreset")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runSkillWithRetries(params: {
  config: ScanRunConfig;
  client: Awaited<ReturnType<typeof createCodexClient>>;
  skill: SkillDescriptor;
  maxAttempts?: number;
}): Promise<SkillRunResult> {
  const maxAttempts = params.maxAttempts ?? 3;

  let latest: SkillRunResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    latest = await runSkillThread({
      client: params.client,
      skill: params.skill,
      repoRoot: params.config.targetRepoPath,
      model: params.config.model
    });

    if (latest.status === "success") {
      return latest;
    }

    if (attempt === maxAttempts || !isRetryableError(latest.error)) {
      return latest;
    }

    const backoff = 500 * 2 ** (attempt - 1);
    await delay(backoff);
  }

  return (
    latest ?? {
      skillName: params.skill.name,
      status: "failed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      outputFile: null,
      error: "Unknown skill execution error.",
      response: null,
      rawResponse: null,
      threadId: null
    }
  );
}

async function writeSkillResult(runResultRoot: string, result: SkillRunResult): Promise<SkillRunResult> {
  const outputPath = path.join(runResultRoot, `${result.skillName}.json`);
  const payload = {
    ...result,
    outputFile: outputPath
  };

  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return payload;
}

function classifySkillOutcome(result: SkillRunResult): "success" | "failed" | "review" {
  if (result.status !== "success" || !result.response) {
    return "failed";
  }

  const rawStaticStatus = String(result.response.static_status || result.response.assessment || "").toLowerCase();
  if (rawStaticStatus === "implemented") {
    return "success";
  }
  if (rawStaticStatus === "missing") {
    return "failed";
  }
  if (rawStaticStatus === "partial") {
    return "review";
  }

  const rawStatus = String(result.response.status || "").toLowerCase();
  if (rawStatus === "pass") {
    return "success";
  }
  if (rawStatus === "fail") {
    return "failed";
  }

  return "review";
}

async function ensureDirectoryPath(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  const targetStat = await stat(resolved);

  if (!targetStat.isDirectory()) {
    throw new Error(`Scan target is not a directory: ${resolved}`);
  }

  return resolved;
}

async function resolveTargetRepoPath(request: ScanRunRequest, runWorkspaceRoot: string): Promise<{
  targetRepoPath: string;
  effectiveRepoUrl: string;
}> {
  if (request.target.sourceType === "github") {
    if (request.target.scanPath) {
      const preparedPath = await ensureDirectoryPath(request.target.scanPath);
      return {
        targetRepoPath: preparedPath,
        effectiveRepoUrl: request.target.repoUrl || `prepared://${request.target.repo}`
      };
    }

    if (!request.target.repoUrl) {
      throw new Error("GitHub scans require a repo URL or a prepared scan path.");
    }

    const clonedTargetPath = path.join(runWorkspaceRoot, "target-repo");
    await cloneTargetRepo(request.target.repoUrl, clonedTargetPath);

    return {
      targetRepoPath: clonedTargetPath,
      effectiveRepoUrl: request.target.repoUrl
    };
  }

  if (!request.target.scanPath) {
    throw new Error("Local scans require a scan path.");
  }

  const localTargetPath = await ensureDirectoryPath(request.target.scanPath);

  return {
    targetRepoPath: localTargetPath,
    effectiveRepoUrl: `local://${request.target.repo}`
  };
}

async function prepareRun(request: ScanRunRequest): Promise<{
  config: ScanRunConfig;
  runWorkspaceRoot: string;
  runResultRoot: string;
  discoveredSkills: SkillDescriptor[];
}> {
  const roots = await ensureScanRoots(request.scansRoot);
  const skillpackClonePath = path.join(roots.skillpacksRoot, "security_skillpacks");
  const skillpackUrl = request.skillpackRepoUrl || DEFAULT_SKILLPACK_REPO_URL;

  await syncSkillpackRepo(skillpackUrl, skillpackClonePath);

  const discoveredSkills = await discoverCodeEvalSkills(skillpackClonePath);
  if (discoveredSkills.length === 0) {
    throw new Error("No code-eval skills found in cloned skillpack repository.");
  }

  const runWorkspaceRoot = path.join(roots.workspacesRoot, request.runId);
  const runResultRoot = path.join(roots.resultsRoot, request.runId);

  await mkdir(runWorkspaceRoot, { recursive: true });
  await mkdir(runResultRoot, { recursive: true });

  const config: ScanRunConfig = {
    repoUrl: request.target.repoUrl || `local://${request.target.repo}`,
    maxConcurrency: request.maxConcurrency,
    runId: request.runId,
    dryRun: Boolean(request.dryRun),
    model: request.model,
    skillpackRepoUrl: skillpackUrl,
    skillpackClonePath,
    targetRepoPath: path.join(runWorkspaceRoot, "target-repo"),
    resultDir: runResultRoot,
    sourceType: request.target.sourceType
  };

  return {
    config,
    runWorkspaceRoot,
    runResultRoot,
    discoveredSkills
  };
}

export async function planScanRun(request: ScanRunRequest): Promise<ScanRunDryPlan> {
  const prepared = await prepareRun(request);

  return {
    config: prepared.config,
    discoveredSkills: prepared.discoveredSkills.map((skill) => skill.name)
  };
}

export async function executeScanRun(
  request: ScanRunRequest,
  callbacks?: {
    onProgress?: (update: SkillProgressUpdate) => void;
  }
): Promise<ScanRunExecutionResult> {
  const prepared = await prepareRun(request);
  const { config, runWorkspaceRoot, runResultRoot, discoveredSkills } = prepared;

  const target = await resolveTargetRepoPath(request, runWorkspaceRoot);
  config.targetRepoPath = target.targetRepoPath;
  config.repoUrl = target.effectiveRepoUrl;

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to execute a scan.");
  }

  const progress = {
    total: discoveredSkills.length,
    completed: 0,
    success: 0,
    failed: 0,
    review: 0
  };

  const startedAt = new Date().toISOString();
  let results: SkillRunResult[] = [];
  let executionError: Error | null = null;

  try {
    const limit = pLimit(request.maxConcurrency);
    const client = await createCodexClient();

    const jobs = discoveredSkills.map((skill) =>
      limit(async () => {
        const result = await runSkillWithRetries({
          config,
          client,
          skill
        });

        const persistedResult = await writeSkillResult(runResultRoot, result);

        progress.completed += 1;
        const outcome = classifySkillOutcome(persistedResult);
        if (outcome === "success") {
          progress.success += 1;
        } else if (outcome === "failed") {
          progress.failed += 1;
        } else {
          progress.review += 1;
        }

        callbacks?.onProgress?.({
          ...progress,
          skillName: skill.name
        });

        return persistedResult;
      })
    );

    results = await Promise.all(jobs);
  } catch (error) {
    executionError = error instanceof Error ? error : new Error(String(error));
  }

  const summary: ScanSummary = {
    runId: request.runId,
    repoUrl: config.repoUrl,
    repoPath: config.targetRepoPath,
    skillpackPath: config.skillpackClonePath,
    model: config.model,
    skillsDiscovered: discoveredSkills.length,
    skillsExecuted: results.length,
    successCount: results.filter((item) => item.status === "success").length,
    failureCount: results.filter((item) => item.status === "failed").length,
    startedAt,
    endedAt: new Date().toISOString(),
    results
  };

  const summaryPath = path.join(runResultRoot, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  if (executionError) {
    throw new Error(`Scan run ${request.runId} failed: ${executionError.message}`);
  }

  return {
    config,
    summary,
    summaryPath
  };
}
