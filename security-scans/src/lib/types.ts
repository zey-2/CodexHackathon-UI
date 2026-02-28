export type SkillAssessment =
  | "implemented"
  | "partial"
  | "missing"
  | "pass"
  | "fail";

export type SkillConfidence = "low" | "medium" | "high" | "n/a";

export type ScanSourceType = "github" | "local";
export type ScanRunLifecycleState = "queued" | "running" | "completed" | "failed";

export interface ScanRunTarget {
  sourceType: ScanSourceType;
  repo: string;
  repoUrl?: string;
  scanPath?: string;
}

export interface ScanRunRequest {
  runId: string;
  maxConcurrency: number;
  model: string;
  skillpackRepoUrl: string;
  scansRoot: string;
  dryRun?: boolean;
  target: ScanRunTarget;
}

export interface ScanRunConfig {
  repoUrl: string;
  maxConcurrency: number;
  runId: string;
  dryRun: boolean;
  model: string;
  skillpackRepoUrl: string;
  skillpackClonePath: string;
  targetRepoPath: string;
  resultDir: string;
  sourceType: ScanSourceType;
}

export interface SkillDescriptor {
  name: string;
  skillMdPath: string;
  skillMdContent: string;
}

export interface SkillFinding {
  severity: string;
  summary: string;
  evidence: string[];
}

export interface SkillEvidenceEntry {
  file?: string;
  line?: number | string;
  detail?: string;
  [key: string]: unknown;
}

export interface SkillResponse {
  mandate_id?: string;
  mandate_title?: string;
  static_status?: "implemented" | "partial" | "missing" | string;
  assessment?: SkillAssessment;
  status?: "pass" | "fail" | string;
  confidence?: SkillConfidence | string;
  severity?: string;
  vulnerability_tags?: string[];
  findings?: SkillFinding[];
  evidence?: Array<SkillEvidenceEntry | string>;
  gaps?: string[];
  next_evidence_requests?: string[];
  assumptions?: string[];
  remediation?: string;
  [key: string]: unknown;
}

export type SkillRunStatus = "success" | "failed";

export interface SkillRunResult {
  skillName: string;
  status: SkillRunStatus;
  startedAt: string;
  endedAt: string;
  outputFile: string | null;
  error: string | null;
  response: SkillResponse | null;
  rawResponse: string | null;
  threadId: string | null;
}

export interface ScanSummary {
  runId: string;
  repoUrl: string;
  repoPath: string;
  skillpackPath: string;
  model: string;
  skillsDiscovered: number;
  skillsExecuted: number;
  successCount: number;
  failureCount: number;
  startedAt: string;
  endedAt: string;
  results: SkillRunResult[];
}

export interface SkillProgress {
  total: number;
  completed: number;
  success: number;
  failed: number;
  review: number;
}

export interface SkillProgressUpdate extends SkillProgress {
  skillName: string;
}

export interface ScanRunState {
  runId: string;
  sessionId: string;
  sourceType: ScanSourceType;
  repo: string;
  scanPath: string;
  state: ScanRunLifecycleState;
  progress: SkillProgress;
  resultDir: string;
  summaryPath: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  updatedAt: string;
}

export interface PreparedSource {
  sourceId: string;
  sourceType: ScanSourceType;
  repo: string;
  scanPath: string;
  repoUrl: string;
  preparedAt: string;
  expiresAt: string;
  used: boolean;
}

export interface ScanRunExecutionResult {
  config: ScanRunConfig;
  summary: ScanSummary;
  summaryPath: string;
}

export interface ScanRunDryPlan {
  config: ScanRunConfig;
  discoveredSkills: string[];
}

export interface ScanReportPayload {
  [key: string]: unknown;
}
