import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  MandateReviewRecord,
  MandateType,
  ScanRunState,
  ScanSummary,
  SkillRunResult
} from "./types.js";

interface MappedMandate {
  code: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "warning";
  status: "pass" | "fail" | "review";
  violation: string;
  required: string;
  document: string;
  section: string;
  reference: string;
  mandateType: MandateType;
  requiredSupportingDocuments: string[];
  reviewOutcome?: "pass" | "fail" | "review";
  reviewedAt?: string;
  reviewFeedback?: string;
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function severityWeight(value: string): number {
  const token = value.toLowerCase();
  if (token.includes("critical")) {
    return 4;
  }
  if (token.includes("high")) {
    return 3;
  }
  if (token.includes("medium") || token.includes("moderate") || token.includes("warning")) {
    return 2;
  }
  if (token.includes("low")) {
    return 1;
  }
  return 0;
}

function normalizeSeverity(value: string): "critical" | "high" | "medium" | "low" | "warning" {
  const token = value.toLowerCase();
  if (token.includes("critical")) {
    return "critical";
  }
  if (token.includes("high")) {
    return "high";
  }
  if (token.includes("medium") || token.includes("moderate")) {
    return "medium";
  }
  if (token.includes("low")) {
    return "low";
  }
  return "warning";
}

function toMandateId(skillName: string): string {
  const match = skillName.match(/mandate-(\d+)-(\d+)-(\d+)/i);
  if (!match) {
    return skillName;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function toMandateTitle(skillName: string): string {
  return skillName
    .replace(/\.json$/i, "")
    .replace(/^mandate-\d+-\d+-\d+-?/i, "")
    .replace(/-/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Mandate Check";
}

function determineMandateType(skillName: string): MandateType {
  if (/-code-evaluation$/i.test(skillName)) {
    return "code-evaluable";
  }

  if (/-code-static-eval$/i.test(skillName)) {
    return "partial-code-evaluable";
  }

  return "non-code-evaluable";
}

function normalizeReviewStatus(value: unknown): "pass" | "fail" | "review" | null {
  const token = String(value || "").trim().toLowerCase();
  if (token === "pass" || token === "fail" || token === "review") {
    return token;
  }

  return null;
}

function extractEvidenceMessage(result: SkillRunResult): string {
  if (result.error) {
    return result.error;
  }

  const evidence = result.response?.evidence;
  if (Array.isArray(evidence) && evidence.length > 0) {
    const first = evidence[0];
    if (typeof first === "string") {
      return first;
    }

    if (first && typeof first === "object") {
      const typed = first as Record<string, unknown>;
      if (typeof typed.detail === "string") {
        return typed.detail;
      }
      if (typeof typed.finding === "string") {
        return typed.finding;
      }
    }
  }

  const reviewResponse = result.response?.assessment;
  if (typeof reviewResponse === "string" && reviewResponse.trim()) {
    return reviewResponse;
  }

  return "Evidence details unavailable.";
}

function extractEvidenceMessageFromResponse(response: Record<string, unknown> | null | undefined): string {
  const evidence = response?.evidence;
  if (Array.isArray(evidence) && evidence.length > 0) {
    const first = evidence[0];
    if (typeof first === "string") {
      return first;
    }

    if (first && typeof first === "object") {
      const typed = first as Record<string, unknown>;
      if (typeof typed.detail === "string") {
        return typed.detail;
      }
      if (typeof typed.finding === "string") {
        return typed.finding;
      }
      if (typeof typed.issues === "string") {
        return typed.issues;
      }
    }
  }

  const reviewResponse = response?.assessment;
  if (typeof reviewResponse === "string" && reviewResponse.trim()) {
    return reviewResponse;
  }

  const note = response?.status;
  if (typeof note === "string" && note.trim()) {
    return note;
  }

  return "Evidence details unavailable.";
}

function extractSupportingDocuments(response: Record<string, unknown> | null | undefined): string[] {
  const candidate = response?.next_evidence_requests;
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function extractRemediationMessage(response: Record<string, unknown> | null | undefined): string {
  const remediation = response?.remediation;
  if (typeof remediation === "string" && remediation.trim()) {
    return remediation;
  }

  const nextEvidenceRequests = response?.next_evidence_requests;
  if (Array.isArray(nextEvidenceRequests) && nextEvidenceRequests.length > 0) {
    const first = nextEvidenceRequests[0];
    if (typeof first === "string" && first.trim()) {
      return first;
    }
  }

  return "Review mandate evidence and apply required remediation controls.";
}

function classifyResult(result: SkillRunResult, response: Record<string, unknown>): MappedMandate {
  const mandateId = String(response.mandate_id || toMandateId(result.skillName));
  const code = `MANDATE-${mandateId}`;
  const title = String(response.mandate_title || toMandateTitle(result.skillName));
  const base = {
    code,
    title,
    document: `Mandate ${mandateId}`,
    section: "Evaluation",
    reference: result.skillName,
    requiredSupportingDocuments: extractSupportingDocuments(response),
    mandateType: determineMandateType(result.skillName)
  };

  if (result.status !== "success") {
    return {
      ...base,
      severity: "critical",
      status: "fail",
      violation: result.error || "Skill execution failed.",
      required: "Retry scan and investigate scanner/runtime failures.",
      section: "Execution"
    };
  }

  const staticStatus = String(response.static_status || response.assessment || "").toLowerCase();
  if (staticStatus === "implemented") {
    return {
      ...base,
      severity: "low",
      status: "pass",
      violation: "Implemented",
      required: "No action required.",
      section: "Static Evaluation"
    };
  }

  if (staticStatus === "missing") {
    return {
      ...base,
      severity: "high",
      status: "fail",
      violation: extractEvidenceMessage(result),
      required: extractRemediationMessage(response),
      section: "Static Evaluation"
    };
  }

  if (staticStatus === "partial") {
    return {
      ...base,
      severity: "warning",
      status: "review",
      violation: extractEvidenceMessage(result),
      required: extractRemediationMessage(response),
      section: "Static Evaluation"
    };
  }

  const status = String(response.status || "").toLowerCase();
  if (status === "pass") {
    return {
      ...base,
      severity: "low",
      status: "pass",
      violation: "Passed",
      required: "No action required.",
      section: "Code Evaluation"
    };
  }

  if (status === "fail") {
    return {
      ...base,
      severity: normalizeSeverity(String(response.severity || "high")),
      status: "fail",
      violation: extractEvidenceMessage(result),
      required: extractRemediationMessage(response),
      section: "Code Evaluation"
    };
  }

  if (status === "review") {
    return {
      ...base,
      severity: "warning",
      status: "review",
      violation: extractEvidenceMessage(result),
      required: extractRemediationMessage(response),
      section: "Code Evaluation"
    };
  }

  return {
    ...base,
    severity: "warning",
    status: "review",
    violation: extractEvidenceMessage(result),
    required: extractRemediationMessage(response),
    section: "Evaluation"
  };
}

function mergeMandateReview(result: SkillRunResult, review: MandateReviewRecord | undefined): MappedMandate {
  const primaryResponse =
    review?.reviewResult?.status === "success" && review.reviewResult.response
      ? (review.reviewResult.response as Record<string, unknown>)
      : (result.response as Record<string, unknown> | null) || {};

  const mandate = classifyResult(result, primaryResponse);

  if (!review?.reviewResult) {
    return mandate;
  }

  const reviewStatus = normalizeReviewStatus(review.reviewResult.response?.status);
  if (review.reviewResult.status === "failed" || reviewStatus === null) {
    return {
      ...mandate,
      reviewOutcome: "review",
      reviewedAt: review.reviewedAt,
      reviewFeedback: review.reviewInput.feedback
    };
  }

  if (reviewStatus === "pass") {
    return {
      ...mandate,
      status: "pass",
      severity: "low",
      violation: extractEvidenceMessageFromResponse(review.reviewResult.response),
      required: "Reviewed and marked as pass by operator feedback.",
      reviewOutcome: reviewStatus,
      reviewedAt: review.reviewedAt,
      reviewFeedback: review.reviewInput.feedback
    };
  }

  if (reviewStatus === "fail") {
    return {
      ...mandate,
      status: "fail",
      violation: extractEvidenceMessageFromResponse(review.reviewResult.response),
      reviewOutcome: reviewStatus,
      reviewedAt: review.reviewedAt,
      reviewFeedback: review.reviewInput.feedback
    };
  }

  return {
    ...mandate,
    status: "review",
    reviewOutcome: "review",
    reviewedAt: review.reviewedAt,
    reviewFeedback: review.reviewInput.feedback,
    violation: `${mandate.violation} // Manual review is required with additional feedback.`
  };
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}_${hour}:${minute}:${second}`;
}

async function readSummary(summaryPath: string): Promise<ScanSummary | null> {
  try {
    const raw = await readFile(summaryPath, "utf8");
    return parseJson(raw) as ScanSummary;
  } catch {
    return null;
  }
}

function listJsonFiles(resultDir: string): Promise<string[]> {
  return readdir(resultDir, { withFileTypes: true }).then((entries) => {
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".json"));
  });
}

async function readSkillResults(resultDir: string): Promise<SkillRunResult[]> {
  const fileNames = await listJsonFiles(resultDir);
  const files = fileNames
    .filter((name) => name !== "summary.json" && name !== "run-state.json")
    .filter((name) => !name.endsWith(".review.json"));

  const results: SkillRunResult[] = [];

  for (const fileName of files) {
    const filePath = path.join(resultDir, fileName);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = parseJson(raw) as SkillRunResult;
      if (parsed && typeof parsed === "object" && typeof parsed.skillName === "string") {
        results.push(parsed);
      }
    } catch {
      // Ignore malformed artifacts.
    }
  }

  return results.sort((a, b) => a.skillName.localeCompare(b.skillName));
}

async function readReviewResults(resultDir: string): Promise<MandateReviewRecord[]> {
  const fileNames = await listJsonFiles(resultDir);
  const files = fileNames.filter((name) => name.endsWith(".review.json"));

  const results: MandateReviewRecord[] = [];

  for (const fileName of files) {
    const filePath = path.join(resultDir, fileName);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = parseJson(raw) as MandateReviewRecord;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.runId === "string" &&
        typeof parsed.skillName === "string" &&
        parsed.reviewResult &&
        typeof parsed.reviewResult === "object"
      ) {
        results.push(parsed);
      }
    } catch {
      // Ignore malformed artifacts.
    }
  }

  return results.sort((a, b) => a.skillName.localeCompare(b.skillName));
}

export async function loadRunSummary(resultsRoot: string, runId: string): Promise<ScanSummary | null> {
  const resultDir = path.join(resultsRoot, runId);
  const summaryPath = path.join(resultDir, "summary.json");
  const summaryStat = await stat(resultDir).catch(() => null);

  if (!summaryStat || !summaryStat.isDirectory()) {
    return null;
  }

  const summaryFromDisk = await readSummary(summaryPath);
  if (summaryFromDisk) {
    const reviewResults = summaryFromDisk.reviewResults?.length
      ? summaryFromDisk.reviewResults
      : await readReviewResults(resultDir);

    return {
      ...summaryFromDisk,
      reviewResults
    };
  }

  const skillResults = await readSkillResults(resultDir);
  if (skillResults.length === 0) {
    return null;
  }

  const reviewResults = await readReviewResults(resultDir);
  const startedAt = skillResults
    .map((item) => Date.parse(item.startedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const endedAt = skillResults
    .map((item) => Date.parse(item.endedAt))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];

  return {
    runId,
    repoUrl: "unknown",
    repoPath: "unknown",
    skillpackPath: "unknown",
    model: "unknown",
    skillsDiscovered: skillResults.length,
    skillsExecuted: skillResults.length,
    successCount: skillResults.filter((item) => item.status === "success").length,
    failureCount: skillResults.filter((item) => item.status === "failed").length,
    startedAt: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : nowIsoFallback(),
    endedAt: Number.isFinite(endedAt) ? new Date(endedAt).toISOString() : nowIsoFallback(),
    results: skillResults,
    reviewResults
  };
}

function nowIsoFallback(): string {
  return new Date().toISOString();
}

export function mapSummaryToScanReport(summary: ScanSummary, runState: ScanRunState | null): Record<string, unknown> {
  const reviewLookup = new Map<string, MandateReviewRecord>();
  for (const item of summary.reviewResults || []) {
    if (item.skillName && item.reviewResult) {
      reviewLookup.set(item.skillName, item);
    }
  }

  const mandates = summary.results.map((result) => mergeMandateReview(result, reviewLookup.get(result.skillName)));

  const failed = mandates.filter((item) => item.status === "fail");
  const passed = mandates.filter((item) => item.status === "pass");
  const review = mandates.filter((item) => item.status === "review");

  const total = Math.max(1, mandates.length);
  const passRate = Math.round((passed.length / total) * 100);

  const criticalCount = failed.filter((item) => item.severity === "critical").length;
  const highCount = failed.filter((item) => item.severity === "high").length;
  const mediumCount = failed.filter((item) => item.severity === "medium").length;
  const lowCount = failed.filter((item) => item.severity === "low").length;
  const reviewCount = review.length;

  const severityValues = failed.map((item) => item.severity);
  const highestSeverity = severityValues
    .sort((a, b) => severityWeight(b) - severityWeight(a))[0] || "success";

  const hasFailures = failed.length > 0;
  const hasCritical = criticalCount > 0;
  const hasReviewOnly = !hasFailures && reviewCount > 0;

  const status = hasCritical
    ? "CRITICAL FAILURE"
    : hasFailures
      ? "MANDATE FAILURE"
      : hasReviewOnly
        ? "REVIEW REQUIRED"
        : "COMPLIANT";

  const severity = hasCritical
    ? "critical"
    : hasFailures
      ? highestSeverity
      : hasReviewOnly
        ? "warning"
        : "success";

  const severityDenominator = Math.max(1, failed.length + reviewCount);

  return {
    refreshMs: 5000,
    systemStatus: "ONLINE",
    health: Math.max(10, Math.min(100, passRate)),
    cpu: "--",
    memory: "--",
    frameworks: [
      { name: "Mandate 2.x", enabled: true },
      { name: "Static Eval", enabled: true },
      { name: "Code Eval", enabled: true },
      { name: "Runtime Evidence", enabled: false }
    ],
    repo: runState?.repo || path.basename(summary.repoPath) || "unknown-repo",
    ref: summary.repoUrl.startsWith("local://") ? "LOCAL_PATH" : "HEAD:default",
    reportId: summary.runId,
    sessionId: runState?.sessionId || "PENDING",
    status,
    severity,
    result: hasFailures ? "COMPLIANCE_VIOLATION" : hasReviewOnly ? "REVIEW_REQUIRED" : "ALL_CHECKS_PASSED",
    action: hasFailures ? "IMMEDIATE_ACTION_REQUIRED" : hasReviewOnly ? "REVIEW_EVIDENCE_REQUESTS" : "CONTINUOUS_MONITORING",
    timestampUtc: formatTimestamp(summary.endedAt),
    passRate,
    success: passed.length,
    fail: failed.length,
    review: review.length,
    severityIndex: [
      {
        label: "CRITICAL_FAIL",
        count: criticalCount,
        percent: Math.round((criticalCount / severityDenominator) * 100),
        severity: "critical"
      },
      {
        label: "HIGH_FAIL",
        count: highCount,
        percent: Math.round((highCount / severityDenominator) * 100),
        severity: "warning"
      },
      {
        label: "MEDIUM_FAIL",
        count: mediumCount,
        percent: Math.round((mediumCount / severityDenominator) * 100),
        severity: "info"
      },
      {
        label: "LOW_FAIL",
        count: lowCount,
        percent: Math.round((lowCount / severityDenominator) * 100),
        severity: "info"
      },
      {
        label: "REVIEW",
        count: reviewCount,
        percent: Math.round((reviewCount / severityDenominator) * 100),
        severity: "warning"
      }
    ],
    failedMandates: failed.map((item) => ({
      severity: item.severity.toUpperCase(),
      icon: item.severity === "critical" ? "report" : "warning",
      code: item.code,
      title: item.title,
      document: item.document,
      section: item.section,
      violation: item.violation,
      required: item.required,
      reference: item.reference,
      mandateType: item.mandateType,
      requiredSupportingDocuments: item.requiredSupportingDocuments,
      reviewOutcome: item.reviewOutcome,
      reviewedAt: item.reviewedAt,
      reviewFeedback: item.reviewFeedback,
      documentationUrl: "../compliance-codex/index.html"
    })),
    reviewMandates: review.map((item) => ({
      severity: "REVIEW",
      icon: "pending",
      code: item.code,
      title: item.title,
      document: item.document,
      section: item.section,
      violation: item.violation,
      required: item.required,
      reference: item.reference,
      mandateType: item.mandateType,
      requiredSupportingDocuments: item.requiredSupportingDocuments,
      reviewOutcome: item.reviewOutcome,
      reviewedAt: item.reviewedAt,
      reviewFeedback: item.reviewFeedback,
      documentationUrl: "../compliance-codex/index.html"
    })),
    passedChecks: passed.map((item) => ({
      code: item.code,
      title: item.title
    })),
    passedOverflow: 0,
    notApplicable: [],
    sessionToken: summary.runId,
    node: "LOCAL-SCAN-SERVER"
  };
}
