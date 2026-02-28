import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeRunId } from "./lib/repo.js";
import { executeScanRun, planScanRun } from "./lib/scan-runner.js";

const DEFAULT_MODEL = process.env.CODEX_MODEL || "codex-mini-latest";
const DEFAULT_MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || "4");
const DEFAULT_SKILLPACK_REPO_URL =
  "https://github.com/zey-2/security_skillpacks.git";

function usage(): string {
  return [
    "Usage:",
    "  npm run scan -- --repo-url <https://github.com/org/repo.git> [options]",
    "",
    "Options:",
    "  --repo-url <url>           Target repository HTTPS URL (required)",
    "  --max-concurrency <n>      Parallel skill threads (default: 4)",
    "  --model <name>             Codex model name (default: codex-mini-latest)",
    "  --run-id <id>              Explicit run id (default: timestamp)",
    "  --skillpack-url <url>      Skillpack git URL",
    "  --dry-run                  Discover skills and print plan only"
  ].join("\n");
}

function parseArgs(argv: string[]): {
  repoUrl: string;
  maxConcurrency: number;
  model: string;
  runId: string;
  dryRun: boolean;
  skillpackUrl: string;
} {
  let repoUrl = "";
  let maxConcurrency = DEFAULT_MAX_CONCURRENCY;
  let model = DEFAULT_MODEL;
  let runId = makeRunId();
  let dryRun = false;
  let skillpackUrl = DEFAULT_SKILLPACK_REPO_URL;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--repo-url") {
      repoUrl = argv[i + 1] || "";
      i += 1;
      continue;
    }

    if (arg === "--max-concurrency") {
      maxConcurrency = Number(argv[i + 1] || "");
      i += 1;
      continue;
    }

    if (arg === "--model") {
      model = argv[i + 1] || model;
      i += 1;
      continue;
    }

    if (arg === "--run-id") {
      runId = argv[i + 1] || runId;
      i += 1;
      continue;
    }

    if (arg === "--skillpack-url") {
      skillpackUrl = argv[i + 1] || skillpackUrl;
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }

    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  if (!repoUrl) {
    throw new Error(`Missing --repo-url\n\n${usage()}`);
  }

  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("--max-concurrency must be a positive integer");
  }

  return {
    repoUrl,
    maxConcurrency,
    model,
    runId,
    dryRun,
    skillpackUrl
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const scansRoot = path.resolve(__dirname, "..");

  if (args.dryRun) {
    const plan = await planScanRun({
      runId: args.runId,
      maxConcurrency: args.maxConcurrency,
      model: args.model,
      skillpackRepoUrl: args.skillpackUrl,
      scansRoot,
      dryRun: true,
      target: {
        sourceType: "github",
        repo: args.repoUrl,
        repoUrl: args.repoUrl
      }
    });

    console.log("Dry run configuration:");
    console.log(`- runId: ${plan.config.runId}`);
    console.log(`- repoUrl: ${plan.config.repoUrl}`);
    console.log(`- model: ${plan.config.model}`);
    console.log(`- maxConcurrency: ${plan.config.maxConcurrency}`);
    console.log(`- skillpackClonePath: ${plan.config.skillpackClonePath}`);
    console.log(`- targetRepoPath: ${plan.config.targetRepoPath}`);
    console.log(`- resultDir: ${plan.config.resultDir}`);
    console.log("");
    console.log(`Discovered ${plan.discoveredSkills.length} code-eval skills:`);
    for (const skillName of plan.discoveredSkills) {
      console.log(`- ${skillName}`);
    }

    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required unless --dry-run is used.");
  }

  const result = await executeScanRun({
    runId: args.runId,
    maxConcurrency: args.maxConcurrency,
    model: args.model,
    skillpackRepoUrl: args.skillpackUrl,
    scansRoot,
    target: {
      sourceType: "github",
      repo: args.repoUrl,
      repoUrl: args.repoUrl
    }
  });

  console.log(`Run complete: ${args.runId}`);
  console.log(`- skills discovered: ${result.summary.skillsDiscovered}`);
  console.log(`- skills executed: ${result.summary.skillsExecuted}`);
  console.log(`- success: ${result.summary.successCount}`);
  console.log(`- failed: ${result.summary.failureCount}`);
  console.log(`- summary: ${result.summaryPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
