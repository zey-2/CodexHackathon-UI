import path from "node:path";

import type {
  MandateReviewResult,
  SkillDescriptor,
  SkillRunResult,
  SkillResponse
} from "./types.js";

const STATIC_EVAL_SKILL_PATTERN = /-code-static-eval$/;
const CODE_EVALUATION_SKILL_PATTERN = /-code-evaluation$/;

const STATIC_EVAL_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: [
    "mandate_id",
    "static_status",
    "confidence",
    "evidence",
    "gaps",
    "next_evidence_requests"
  ],
  properties: {
    mandate_id: { type: "string" },
    mandate_title: { type: "string" },
    static_status: {
      type: "string",
      enum: ["implemented", "partial", "missing"]
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high", "n/a"]
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true
      }
    },
    gaps: {
      type: "array",
      items: { type: "string" }
    },
    next_evidence_requests: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;

const CODE_EVALUATION_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["mandate_id", "status", "severity", "evidence", "remediation"],
  properties: {
    mandate_id: { type: "string" },
    mandate_title: { type: "string" },
    status: {
      type: "string",
      enum: ["pass", "fail"]
    },
    severity: { type: "string" },
    vulnerability_tags: {
      type: "array",
      items: { type: "string" }
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true
      }
    },
    remediation: { type: "string" }
  }
} as const;

const SKILL_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["mandate_id"],
  properties: {
    mandate_id: { type: "string" }
  }
} as const;

const MANDATE_REVIEW_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["mandate_id", "status", "confidence"],
  properties: {
    mandate_id: { type: "string" },
    mandate_title: { type: "string" },
    status: {
      type: "string",
      enum: ["pass", "fail", "review"]
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high", "n/a"]
    },
    assessment: {
      type: "string"
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true
      }
    },
    next_evidence_requests: {
      type: "array",
      items: { type: "string" }
    },
    remediation: {
      type: "string"
    },
    next_steps: {
      type: "array",
      items: { type: "string" }
    },
    assumptions: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;

function selectOutputSchemaForSkill(skillName: string): unknown {
  if (STATIC_EVAL_SKILL_PATTERN.test(skillName)) {
    return STATIC_EVAL_RESPONSE_SCHEMA;
  }

  if (CODE_EVALUATION_SKILL_PATTERN.test(skillName)) {
    return CODE_EVALUATION_RESPONSE_SCHEMA;
  }

  return SKILL_RESPONSE_SCHEMA;
}

type AnyCodexClient = {
  startThread: (...args: unknown[]) => Promise<unknown> | unknown;
};

type AnyThread = {
  run: (...args: unknown[]) => Promise<unknown> | unknown;
  id?: string;
  threadId?: string;
};

function buildPrompt(skill: SkillDescriptor, repoRoot: string): string {
  return [
    "You are running a security compliance static evaluation skill.",
    `Skill name: ${skill.name}`,
    `Target repository root path: ${repoRoot}`,
    "",
    "Requirements:",
    "1) Follow the skill instructions exactly.",
    "2) Perform static code analysis only.",
    "3) Do not mutate files or execute destructive commands.",
    "4) Return ONLY valid JSON matching the required schema.",
    "",
    "Skill specification follows:",
    skill.skillMdContent
  ].join("\n");
}

function serializeValueBlock(value: unknown): string {
  if (!value) {
    return "No additional context provided.";
  }
  if (typeof value === "string") {
    return value.trim() || "No additional context provided.";
  }
  return JSON.stringify(value, null, 2);
}

function buildReviewPrompt(params: {
  skillName: string;
  originalResult: SkillRunResult;
  feedback: string;
  supportingDocuments: string[];
  repoRoot: string;
}): string {
  return [
    "You are a compliance review specialist re-evaluating an already-scanned mandate.",
    `Mandate identifier: ${params.skillName}`,
    `Target repository root path: ${path.resolve(params.repoRoot)}`,
    "",
    "Task:",
    "1) Review the original static/code evaluation output and the operator-provided supporting artifacts.",
    "2) Re-evaluate only whether this mandate still requires remediation based on all available input.",
    "3) Return ONLY valid JSON using one of the required statuses: pass, fail, review.",
    "4) If status is review, list what additional evidence is still required.",
    "",
    "Original mandate evaluation output:",
    serializeValueBlock(params.originalResult.response),
    "",
    "User feedback:",
    params.feedback.trim() || "No feedback provided.",
    "",
    "User-supplied supporting documents:",
    params.supportingDocuments.length > 0
      ? params.supportingDocuments.map((item) => `- ${item}`).join("\n")
      : "None provided.",
    "",
    "Output schema fields:",
    "- status: pass | fail | review",
    "- mandate_id: same as original mandate_id if available",
    "- assessment: concise rationale",
    "- confidence: low|medium|high|n/a",
    "- evidence: any evidence entries supporting the outcome",
    "- next_evidence_requests: required documents for non-pass statuses",
    "- remediation or next_steps: optional remediation guidance",
    "- assumptions: optional context assumptions that affect evaluation"
  ].join("\n");
}

export async function createCodexClient(): Promise<AnyCodexClient> {
  const mod = (await import("@openai/codex-sdk")) as Record<string, unknown>;

  const codexCtor =
    (mod.Codex as (new (...args: unknown[]) => AnyCodexClient) | undefined) ??
    (mod.default as (new (...args: unknown[]) => AnyCodexClient) | undefined);

  if (codexCtor) {
    return new codexCtor();
  }

  const createClient = mod.createCodex as (() => AnyCodexClient) | undefined;
  if (createClient) {
    return createClient();
  }

  throw new Error("Unable to initialize @openai/codex-sdk client.");
}

async function startThreadWithFallback(client: AnyCodexClient, repoRoot: string): Promise<AnyThread> {
  const attempts: Array<() => Promise<unknown> | unknown> = [
    () => client.startThread({ workingDirectory: repoRoot }),
    () => client.startThread({ cwd: repoRoot }),
    () => client.startThread(repoRoot),
    () => client.startThread()
  ];

  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      const thread = await attempt();
      if (thread && typeof (thread as AnyThread).run === "function") {
        return thread as AnyThread;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Could not start Codex thread for ${repoRoot}: ${String(lastError)}`);
}

async function runThreadWithFallback(
  thread: AnyThread,
  prompt: string,
  model: string,
  outputSchema: unknown
): Promise<unknown> {
  const attempts: Array<() => Promise<unknown> | unknown> = [
    () => thread.run(prompt, { model, outputSchema }),
    () =>
      thread.run({
        prompt,
        model,
        outputSchema
      }),
    () =>
      thread.run(prompt, {
        model,
        schema: outputSchema
      }),
    () => thread.run(prompt)
  ];

  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to run Codex thread: ${String(lastError)}`);
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const candidateObject = value as Record<string, unknown>;

  const directText =
    candidateObject.finalResponse ??
    candidateObject.final_response ??
    candidateObject.output_text ??
    candidateObject.text ??
    candidateObject.message ??
    candidateObject.content;

  if (typeof directText === "string") {
    return directText;
  }

  if (typeof candidateObject.response === "string") {
    return candidateObject.response;
  }

  if (candidateObject.response && typeof candidateObject.response === "object") {
    const responseObj = candidateObject.response as Record<string, unknown>;
    const nestedText =
      responseObj.finalResponse ??
      responseObj.final_response ??
      responseObj.output_text ??
      responseObj.text ??
      responseObj.content;
    if (typeof nestedText === "string") {
      return nestedText;
    }
  }

  if (Array.isArray(candidateObject.items)) {
    for (let i = candidateObject.items.length - 1; i >= 0; i -= 1) {
      const item = candidateObject.items[i];
      if (!item || typeof item !== "object") {
        continue;
      }

      const typedItem = item as Record<string, unknown>;
      if (typedItem.type === "agent_message" && typeof typedItem.text === "string") {
        return typedItem.text;
      }
    }
  }

  return JSON.stringify(value);
}

function parseJsonBlock(rawText: string): unknown {
  const trimmed = rawText.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }

  throw new Error("Model output was not plain JSON.");
}

function coerceSkillResponse(parsed: unknown): SkillResponse {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Parsed response was not an object.");
  }

  return parsed as SkillResponse;
}

export async function runSkillThread(params: {
  client: AnyCodexClient;
  skill: SkillDescriptor;
  repoRoot: string;
  model: string;
}): Promise<SkillRunResult> {
  const startedAt = new Date().toISOString();
  let threadId: string | null = null;
  let rawResponse: string | null = null;

  try {
    const thread = await startThreadWithFallback(params.client, params.repoRoot);
    threadId = thread.id ?? thread.threadId ?? null;

    const prompt = buildPrompt(params.skill, path.resolve(params.repoRoot));
    const outputSchema = selectOutputSchemaForSkill(params.skill.name);
    const runResponse = await runThreadWithFallback(thread, prompt, params.model, outputSchema);
    threadId = thread.id ?? thread.threadId ?? threadId;
    rawResponse = extractTextFromUnknown(runResponse);
    const parsed = parseJsonBlock(rawResponse);
    const response = coerceSkillResponse(parsed);

    return {
      skillName: params.skill.name,
      status: "success",
      startedAt,
      endedAt: new Date().toISOString(),
      outputFile: null,
      error: null,
      response,
      rawResponse,
      threadId
    };
  } catch (error) {
    return {
      skillName: params.skill.name,
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      outputFile: null,
      error: error instanceof Error ? error.message : String(error),
      response: null,
      rawResponse,
      threadId
    };
  }
}

export async function runMandateReviewThread(params: {
  client: AnyCodexClient;
  skillName: string;
  originalResult: SkillRunResult;
  feedback: string;
  supportingDocuments: string[];
  repoRoot: string;
  model: string;
}): Promise<MandateReviewResult> {
  const startedAt = new Date().toISOString();
  let threadId: string | null = null;
  let rawResponse: string | null = null;

  try {
    const thread = await startThreadWithFallback(params.client, params.repoRoot);
    threadId = thread.id ?? thread.threadId ?? null;

    const prompt = buildReviewPrompt({
      skillName: params.skillName,
      originalResult: params.originalResult,
      feedback: params.feedback,
      supportingDocuments: params.supportingDocuments,
      repoRoot: params.repoRoot
    });

    const runResponse = await runThreadWithFallback(thread, prompt, params.model, MANDATE_REVIEW_RESPONSE_SCHEMA);
    threadId = thread.id ?? thread.threadId ?? threadId;
    rawResponse = extractTextFromUnknown(runResponse);
    const parsed = parseJsonBlock(rawResponse);
    const response = coerceSkillResponse(parsed);

    if (typeof response.mandate_id === "string" && response.mandate_id.trim()) {
      response.mandate_id = response.mandate_id.trim();
    } else if (params.originalResult.response?.mandate_id) {
      response.mandate_id = params.originalResult.response.mandate_id;
    } else {
      response.mandate_id = params.skillName;
    }

    return {
      status: "success",
      startedAt,
      endedAt: new Date().toISOString(),
      outputFile: null,
      error: null,
      response,
      rawResponse,
      threadId
    };
  } catch (error) {
    return {
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      outputFile: null,
      error: error instanceof Error ? error.message : String(error),
      response: null,
      rawResponse,
      threadId
    };
  }
}

export {
  CODE_EVALUATION_RESPONSE_SCHEMA,
  MANDATE_REVIEW_RESPONSE_SCHEMA,
  SKILL_RESPONSE_SCHEMA,
  STATIC_EVAL_RESPONSE_SCHEMA
};
