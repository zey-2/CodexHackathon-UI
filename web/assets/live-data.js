(() => {
  const page = document.body?.dataset?.page;
  if (!page) {
    return;
  }

  const defaultEndpoints = {
    dashboard: [
      window.NEON_DATA_ENDPOINTS?.dashboard,
      "/api/dashboard",
      "../../data/dashboard.json"
    ],
    codex: [
      window.NEON_DATA_ENDPOINTS?.codex,
      "/api/compliance-codex",
      "../../data/compliance-codex.json"
    ],
    "scan-report": [
      window.NEON_DATA_ENDPOINTS?.scanReport,
      "/api/scan-report",
      "../../data/scan-report.json"
    ]
  };

  const renderers = {
    dashboard: renderDashboard,
    codex: renderCodex,
    "scan-report": renderScanReport
  };
  const SCAN_CONTEXT_KEY = "neon_guardian_scan_context_v1";
  const SOURCE_TYPE_LOCAL = "local";
  const SOURCE_TYPE_GITHUB = "github";

  initialize().catch(() => {
    // Keep static HTML as fallback if live data fails.
  });

  async function initialize() {
    const renderer = renderers[page];
    if (!renderer) {
      return;
    }

    const firstData = await loadPageData(page);
    renderer(firstData && typeof firstData === "object" ? firstData : {});

    const refreshMs = getPositiveNumber(firstData?.refreshMs, window.NEON_REFRESH_MS, 30000);
    window.setInterval(async () => {
      const nextData = await loadPageData(page);
      renderer(nextData && typeof nextData === "object" ? nextData : {});
    }, refreshMs);
  }

  async function loadPageData(pageKey) {
    const configured = defaultEndpoints[pageKey] || [];
    const candidates =
      pageKey === "scan-report"
        ? resolveScanReportCandidates(configured)
        : [...new Set(configured.filter(Boolean))];

    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          headers: {
            Accept: "application/json"
          }
        });
        if (!response.ok) {
          continue;
        }
        const payload = await response.json();
        if (payload && typeof payload === "object") {
          return payload;
        }
      } catch (_error) {
        // Try the next endpoint.
      }
    }

    return null;
  }

  function resolveScanReportCandidates(configuredCandidates) {
    const baseCandidates = [...new Set(toArray(configuredCandidates).filter(Boolean))];
    const runId = resolvePreferredReportRunId();
    if (!isFilled(runId)) {
      return baseCandidates;
    }
    return baseCandidates.map((url) => withRunIdQuery(url, runId));
  }

  function resolvePreferredReportRunId() {
    const urlRunId = String(new URLSearchParams(window.location.search).get("runId") || "").trim();
    if (isFilled(urlRunId)) {
      return urlRunId;
    }

    const storedContext = getStoredScanContext();
    return firstFilled(storedContext.runId, storedContext.latestRunId);
  }

  function withRunIdQuery(url, runId) {
    const rawUrl = String(url || "").trim();
    const normalizedRunId = String(runId || "").trim();
    if (!isFilled(rawUrl) || !isFilled(normalizedRunId)) {
      return rawUrl;
    }
    if (!rawUrl.includes("/api/scan")) {
      return rawUrl;
    }

    try {
      const parsed = new URL(rawUrl, window.location.origin);
      parsed.searchParams.set("runId", normalizedRunId);
      if (/^https?:\/\//i.test(rawUrl)) {
        return parsed.toString();
      }
      return `${parsed.pathname}${parsed.search}`;
    } catch (_error) {
      const separator = rawUrl.includes("?") ? "&" : "?";
      return `${rawUrl}${separator}runId=${encodeURIComponent(normalizedRunId)}`;
    }
  }

  function getStoredScanContext() {
    try {
      const raw = window.localStorage.getItem(SCAN_CONTEXT_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function storeScanContext(context) {
    try {
      window.localStorage.setItem(SCAN_CONTEXT_KEY, JSON.stringify(context));
    } catch (_error) {
      // Ignore storage errors.
    }
  }

  function mergeScanContext(nextFields) {
    const current = getStoredScanContext();
    const next = {
      ...current,
      ...(nextFields && typeof nextFields === "object" ? nextFields : {}),
      updatedAt: new Date().toISOString()
    };
    storeScanContext(next);
    return next;
  }

  function normalizeRepoName(value) {
    if (!isFilled(value)) {
      return "";
    }

    const text = String(value).trim();
    const parts = text.split(":");
    const candidate = parts.length > 1 ? parts.slice(1).join(":") : text;
    return candidate.trim().replace(/\s+/g, "-");
  }

  function generateSessionId(repo) {
    const repoToken = normalizeRepoName(repo).replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase() || "SCAN";
    const timestamp = Date.now().toString(36).toUpperCase().slice(-6);
    const nonce = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `NG-${repoToken}-${timestamp}${nonce}`;
  }

  function upsertScanContext(repoCandidate, sessionCandidate, forceNewSession) {
    const context = getStoredScanContext();
    const repo = normalizeRepoName(repoCandidate) || normalizeRepoName(context.repo) || "unknown-repo";
    const repoChanged = normalizeRepoName(context.repo) !== repo;
    const providedSession = isFilled(sessionCandidate) ? String(sessionCandidate) : "";

    const sessionId =
      providedSession ||
      (forceNewSession || repoChanged || !isFilled(context.sessionId) ? generateSessionId(repo) : String(context.sessionId));

    const nextContext = {
      ...context,
      repo,
      sessionId,
      updatedAt: new Date().toISOString()
    };
    storeScanContext(nextContext);
    return nextContext;
  }

  function applyHeaderScanContext(repoElementId, sessionElementId, repoCandidate, sessionCandidate, forceNewSession) {
    const context = upsertScanContext(repoCandidate, sessionCandidate, forceNewSession);
    setText(repoElementId, context.repo);
    setText(sessionElementId, context.sessionId);
    return context;
  }

  function renderDashboard(data) {
    const sourceData = data && typeof data === "object" ? data : {};

    const systemStatus = toUpper(sourceData.systemStatus);
    if (systemStatus) {
      setText("dashboard-system-status", `SYSTEM_STATUS: ${systemStatus}`);
    }

    if (isFilled(sourceData.uplinkStatus)) {
      setText("dashboard-uplink-status", `Uplink: ${sourceData.uplinkStatus}`);
    }
    if (isFilled(sourceData.node)) {
      setText("dashboard-node", sourceData.node);
    }
    if (isFilled(sourceData.latency)) {
      setText("dashboard-latency", sourceData.latency);
    }
    if (isFilled(sourceData.user)) {
      setText("dashboard-operator", sourceData.user);
    }
    if (isFilled(sourceData.protocol)) {
      setText("dashboard-protocol", `Protocol: ${sourceData.protocol}`);
    }

    const targetInput = byId("dashboard-target-input");
    if (targetInput && !targetInput.dataset.boundUserInputTracker) {
      targetInput.dataset.boundUserInputTracker = "1";
      targetInput.addEventListener("input", () => {
        targetInput.dataset.userEdited = "1";
      });
    }
    if (targetInput && isFilled(sourceData.targetInput) && targetInput.dataset.userEdited !== "1") {
      targetInput.value = sourceData.targetInput;
    }

    const storedContext = getStoredScanContext();
    const repoFromDashboard = normalizeRepoName(storedContext.repo || sourceData.repo || targetInput?.value || sourceData.targetInput);
    applyHeaderScanContext("dashboard-header-repo", "dashboard-session-id", repoFromDashboard, sourceData.sessionId, false);
    initializeDashboardSourceControls(sourceData, targetInput, repoFromDashboard);

    const frameworks = toArray(sourceData.frameworks);
    const frameworkList = byId("dashboard-framework-list");
    if (frameworkList && frameworks.length > 0) {
      frameworkList.innerHTML = frameworks
        .map((framework) => {
          const enabled = framework.enabled !== false;
          const rowClass = enabled
            ? "flex items-center justify-between group"
            : "flex items-center justify-between group opacity-75 hover:opacity-100 transition-opacity";
          const nameClass = enabled
            ? "text-[11px] font-code text-text-main group-hover:text-primary transition-colors"
            : "text-[11px] font-code text-text-muted group-hover:text-text-main transition-colors";

          return `
            <div class="${rowClass}">
              <span class="${nameClass}">${escapeHtml(framework.name || "UNKNOWN")}</span>
              <label class="relative inline-flex items-center cursor-pointer">
                <input ${enabled ? "checked" : ""} class="sr-only peer" type="checkbox" value=""/>
                <div class="w-8 h-4 bg-surface peer-focus:outline-none border border-border rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-muted after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary/20 peer-checked:border-primary peer-checked:after:bg-primary peer-checked:after:border-primary"></div>
              </label>
            </div>
          `;
        })
        .join("");
    }

    const logs = toArray(sourceData.logs);
    const logsList = byId("dashboard-logs-list");
    if (logsList && logs.length > 0) {
      logsList.innerHTML = `${logs
        .map((log, index) => {
          const levelClass = getLogLevelClass(log.level);
          const source = toUpper(log.source || "LOG");
          const time = escapeHtml(normalizeTime(log.time));
          const message = escapeHtml(log.message || "");
          const rowPadding = index >= 3 ? " pt-2" : "";

          return `
            <div class="flex gap-4${rowPadding}">
              <span class="text-text-muted shrink-0">[${time}]</span>
              <span class="${levelClass}">${source}:</span>
              <span class="text-text-main">${message}</span>
            </div>
          `;
        })
        .join("")}
        <div class="flex gap-4">
          <span class="text-primary shrink-0">&gt;</span>
          <span class="text-primary w-2 h-4 bg-primary cursor-blink"></span>
        </div>`;
    }

    if (sourceData.summary && typeof sourceData.summary === "object") {
      if (Number.isFinite(Number(sourceData.summary.entries))) {
        setText("dashboard-log-entries", `ENTRIES: ${Number(sourceData.summary.entries).toLocaleString("en-US")}`);
      }
      if (Number.isFinite(Number(sourceData.summary.errors))) {
        setText("dashboard-log-errors", `ERRORS: ${Number(sourceData.summary.errors).toLocaleString("en-US")}`);
      }
      if (Number.isFinite(Number(sourceData.summary.warnings))) {
        setText("dashboard-log-warnings", `WARNINGS: ${Number(sourceData.summary.warnings).toLocaleString("en-US")}`);
      }
    }

    const threatFeed = byId("dashboard-threat-feed");
    const threats = toArray(sourceData.threats);
    if (threatFeed && threats.length > 0) {
      threatFeed.innerHTML = threats
        .map((threat) => {
          const severity = String(threat.severity || "info").toLowerCase();
          const label = toUpper(threat.label || severity);
          const className =
            severity === "critical" ? "text-critical" : severity === "warning" ? "text-warning" : "text-primary";
          return `<span class="${className}">${escapeHtml(label)}:</span> ${escapeHtml(threat.message || "")}`;
        })
        .join(" --- ");
    }
  }

  function initializeDashboardSourceControls(data, targetInput, fallbackRepo) {
    const localButton = byId("dashboard-source-local");
    const githubButton = byId("dashboard-source-github");
    const localPanel = byId("dashboard-local-source-panel");
    const githubPanel = byId("dashboard-github-source-panel");
    const localPathInput = byId("dashboard-local-path-input");
    const githubUrlInput = byId("dashboard-github-url-input");
    const executeScanButton = byId("dashboard-execute-scan");
    if (!localButton || !githubButton || !localPanel || !githubPanel || !executeScanButton) {
      return;
    }

    const setActiveSourceMode = (nextSourceType, persist) => {
      const activeSourceType = nextSourceType === SOURCE_TYPE_GITHUB ? SOURCE_TYPE_GITHUB : SOURCE_TYPE_LOCAL;
      localButton.dataset.sourceType = activeSourceType;

      localPanel.classList.toggle("hidden", activeSourceType !== SOURCE_TYPE_LOCAL);
      githubPanel.classList.toggle("hidden", activeSourceType !== SOURCE_TYPE_GITHUB);

      localButton.classList.toggle("border-primary/40", activeSourceType === SOURCE_TYPE_LOCAL);
      localButton.classList.toggle("bg-primary/10", activeSourceType === SOURCE_TYPE_LOCAL);
      localButton.classList.toggle("text-primary", activeSourceType === SOURCE_TYPE_LOCAL);
      localButton.classList.toggle("border-border", activeSourceType !== SOURCE_TYPE_LOCAL);
      localButton.classList.toggle("text-text-muted", activeSourceType !== SOURCE_TYPE_LOCAL);

      githubButton.classList.toggle("border-primary/40", activeSourceType === SOURCE_TYPE_GITHUB);
      githubButton.classList.toggle("bg-primary/10", activeSourceType === SOURCE_TYPE_GITHUB);
      githubButton.classList.toggle("text-primary", activeSourceType === SOURCE_TYPE_GITHUB);
      githubButton.classList.toggle("border-border", activeSourceType !== SOURCE_TYPE_GITHUB);
      githubButton.classList.toggle("text-text-muted", activeSourceType !== SOURCE_TYPE_GITHUB);

      if (persist) {
        mergeScanContext({ sourceType: activeSourceType });
      }

      if (targetInput && targetInput.dataset.userEdited !== "1") {
        const nextTargetValue =
          activeSourceType === SOURCE_TYPE_GITHUB
            ? String(githubUrlInput?.value || "")
            : String(localPathInput?.value || "");
        if (isFilled(nextTargetValue)) {
          targetInput.value = nextTargetValue;
        } else if (isFilled(data.targetInput)) {
          targetInput.value = data.targetInput;
        }
      }

      const modeText =
        activeSourceType === SOURCE_TYPE_GITHUB
          ? "GitHub mode active. Repository will be cloned to temporary folder before scan."
          : "Local mode active. Enter an absolute server path to scan.";
      setDashboardSourceStatus(modeText, "info");
    };

    if (localButton.dataset.boundSourceControls === "1") {
      return;
    }
    localButton.dataset.boundSourceControls = "1";

    const storedContext = getStoredScanContext();
    const initialSourceType = storedContext.sourceType === SOURCE_TYPE_GITHUB ? SOURCE_TYPE_GITHUB : SOURCE_TYPE_LOCAL;
    const storedLocalPath = String(storedContext.localPath || "");
    const storedGitHubUrl = String(storedContext.githubUrl || "");
    const storedScanTargetPath = String(storedContext.scanTargetPath || "");

    if (localPathInput && isFilled(storedLocalPath)) {
      localPathInput.value = storedLocalPath;
    }
    if (githubUrlInput && isFilled(storedGitHubUrl)) {
      githubUrlInput.value = storedGitHubUrl;
    }
    if (targetInput && isFilled(storedScanTargetPath) && targetInput.dataset.userEdited !== "1") {
      targetInput.value = storedScanTargetPath;
    }

    localButton.addEventListener("click", () => {
      setActiveSourceMode(SOURCE_TYPE_LOCAL, true);
    });
    githubButton.addEventListener("click", () => {
      setActiveSourceMode(SOURCE_TYPE_GITHUB, true);
    });

    if (localPathInput) {
      localPathInput.addEventListener("input", () => {
        localPathInput.dataset.userEdited = "1";
        const localPath = String(localPathInput.value || "").trim();
        mergeScanContext({
          sourceType: SOURCE_TYPE_LOCAL,
          localPath
        });

        if (targetInput && localButton.dataset.sourceType === SOURCE_TYPE_LOCAL) {
          targetInput.value = localPath;
          targetInput.dataset.userEdited = "1";
        }

        const repoFromPath = normalizeRepoName(getPathBasename(localPath));
        if (isFilled(repoFromPath)) {
          applyHeaderScanContext("dashboard-header-repo", "dashboard-session-id", repoFromPath, "", false);
        }
      });
    }

    if (githubUrlInput) {
      githubUrlInput.addEventListener("input", () => {
        githubUrlInput.dataset.userEdited = "1";
        const githubUrl = String(githubUrlInput.value || "").trim();
        mergeScanContext({
          sourceType: SOURCE_TYPE_GITHUB,
          githubUrl
        });

        if (targetInput && localButton.dataset.sourceType === SOURCE_TYPE_GITHUB) {
          targetInput.value = githubUrl;
          targetInput.dataset.userEdited = "1";
        }

        const repoFromUrl = extractRepoNameFromGitHubUrl(githubUrl);
        if (isFilled(repoFromUrl)) {
          applyHeaderScanContext("dashboard-header-repo", "dashboard-session-id", repoFromUrl, "", false);
        }
      });
    }

    executeScanButton.addEventListener("click", async () => {
      if (executeScanButton.dataset.scanInProgress === "1") {
        return;
      }

      const selectedSourceType =
        localButton.dataset.sourceType === SOURCE_TYPE_GITHUB ? SOURCE_TYPE_GITHUB : SOURCE_TYPE_LOCAL;
      const localPath = String(localPathInput?.value || "").trim();
      const githubUrl = String(githubUrlInput?.value || "").trim();

      if (selectedSourceType === SOURCE_TYPE_LOCAL && !isFilled(localPath)) {
        setDashboardSourceStatus("Select a local folder before running scan.", "error");
        return;
      }
      if (selectedSourceType === SOURCE_TYPE_GITHUB && !isGitHubRepoUrl(githubUrl)) {
        setDashboardSourceStatus("Enter a valid GitHub repository URL before running scan.", "error");
        return;
      }

      executeScanButton.dataset.scanInProgress = "1";
      executeScanButton.disabled = true;
      executeScanButton.classList.add("opacity-70", "cursor-not-allowed");

      try {
        const preparingMessage =
          selectedSourceType === SOURCE_TYPE_GITHUB
            ? "Cloning GitHub repository to temporary folder..."
            : "Preparing local folder for scan...";
        setDashboardSourceStatus(preparingMessage, "info");

        const prepared = await prepareDashboardScanSource(selectedSourceType, {
          localPath,
          githubUrl
        });
        const sourceId = String(prepared.sourceId || "").trim();
        if (!isFilled(sourceId)) {
          throw new Error("Source preparation did not return sourceId.");
        }
        const resolvedScanPath = String(prepared.scanPath || "").trim();
        if (!isFilled(resolvedScanPath)) {
          throw new Error("Unable to resolve scan target path.");
        }

        if (targetInput) {
          targetInput.value = resolvedScanPath;
          targetInput.dataset.userEdited = "1";
        }

        const resolvedRepo = normalizeRepoName(
          prepared.repo ||
            extractRepoNameFromGitHubUrl(githubUrl) ||
            getPathBasename(resolvedScanPath) ||
            fallbackRepo ||
            data.targetInput ||
            "unknown-repo"
        );

        const headerContext = applyHeaderScanContext("dashboard-header-repo", "dashboard-session-id", resolvedRepo, "", true);
        mergeScanContext({
          ...headerContext,
          sourceType: selectedSourceType,
          sourceId,
          githubUrl: selectedSourceType === SOURCE_TYPE_GITHUB ? githubUrl : "",
          localPath: selectedSourceType === SOURCE_TYPE_LOCAL ? localPath : "",
          scanTargetPath: resolvedScanPath
        });

        const scanStarted = await dispatchDashboardScanStart({
          sourceId,
          sessionId: headerContext.sessionId
        });
        if (!scanStarted || !scanStarted.body || typeof scanStarted.body !== "object") {
          throw new Error("Scan start endpoint unavailable. Configure /api/scan/start.");
        }

        const runId = firstFilled(scanStarted.body.runId);
        if (!isFilled(runId)) {
          throw new Error("Scan start response did not include runId.");
        }
        const statusUrl = firstFilled(
          scanStarted.body.statusUrl,
          `/api/scan/status?runId=${encodeURIComponent(runId)}`
        );
        const reportUrl = firstFilled(
          scanStarted.body.reportUrl,
          `/api/scan-report?runId=${encodeURIComponent(runId)}`
        );

        mergeScanContext({
          runId,
          latestRunId: runId,
          scanStatusUrl: statusUrl,
          scanReportUrl: reportUrl
        });

        setDashboardSourceStatus(`Scan ${runId} started. Polling status...`, "info");
        void pollDashboardScanStatus({
          runId,
          statusUrl,
          reportUrl
        });
      } catch (error) {
        const failureMessage =
          error instanceof Error && isFilled(error.message)
            ? error.message
            : "Scan preparation failed. Check source configuration.";
        setDashboardSourceStatus(failureMessage, "error");
      } finally {
        executeScanButton.dataset.scanInProgress = "0";
        executeScanButton.disabled = false;
        executeScanButton.classList.remove("opacity-70", "cursor-not-allowed");
      }
    });

    setActiveSourceMode(initialSourceType, false);
  }

  async function prepareDashboardScanSource(sourceType, input) {
    if (sourceType === SOURCE_TYPE_GITHUB) {
      return prepareGitHubScanSource(input.githubUrl);
    }

    return prepareLocalScanSource(input.localPath);
  }

  async function prepareGitHubScanSource(repoUrl) {
    if (!isGitHubRepoUrl(repoUrl)) {
      throw new Error("GitHub URL must look like https://github.com/org/repo(.git).");
    }

    const response = await postJsonToCandidateEndpoints(
      [
        window.NEON_SCAN_ENDPOINTS?.prepareSource,
        window.NEON_SCAN_ENDPOINTS?.prepare,
        window.NEON_DATA_ENDPOINTS?.prepareSource,
        "/api/scan/prepare-source",
        "/api/scan/prepare"
      ],
      {
        sourceType: SOURCE_TYPE_GITHUB,
        repoUrl: String(repoUrl).trim(),
        cloneToTemp: true
      }
    );

    if (!response || !response.body || typeof response.body !== "object") {
      throw new Error("Backend clone endpoint is unavailable. Configure /api/scan/prepare-source.");
    }

    const sourceId = firstFilled(response.body.sourceId);
    const scanPath = firstFilled(
      response.body.scanPath,
      response.body.targetPath,
      response.body.path,
      response.body.tempPath,
      response.body.localPath
    );
    if (!isFilled(sourceId)) {
      throw new Error("GitHub source prepare did not return sourceId.");
    }
    if (!isFilled(scanPath)) {
      throw new Error("GitHub repo was prepared, but no temp scan path was returned.");
    }

    return {
      sourceId: String(sourceId),
      scanPath: String(scanPath),
      repo: firstFilled(response.body.repo, extractRepoNameFromGitHubUrl(repoUrl))
    };
  }

  async function prepareLocalScanSource(localPath) {
    const normalizedPath = String(localPath || "").trim();
    if (!isFilled(normalizedPath)) {
      throw new Error("Enter a server local path before running scan.");
    }

    const response = await postJsonToCandidateEndpoints(
      [
        window.NEON_SCAN_ENDPOINTS?.prepareSource,
        window.NEON_SCAN_ENDPOINTS?.prepare,
        window.NEON_DATA_ENDPOINTS?.prepareSource,
        "/api/scan/prepare-source",
        "/api/scan/prepare"
      ],
      {
        sourceType: SOURCE_TYPE_LOCAL,
        localPath: normalizedPath
      }
    );

    if (!response || !response.body || typeof response.body !== "object") {
      throw new Error("Local source preparation endpoint is unavailable.");
    }

    const sourceId = firstFilled(response.body.sourceId);
    const scanPath = firstFilled(response.body.scanPath, response.body.localPath, normalizedPath);
    if (!isFilled(sourceId)) {
      throw new Error("Local source prepare did not return sourceId.");
    }
    if (!isFilled(scanPath)) {
      throw new Error("Local source prepare did not return scanPath.");
    }

    return {
      sourceId: String(sourceId),
      scanPath: String(scanPath),
      repo: firstFilled(response.body.repo, getPathBasename(scanPath))
    };
  }

  async function dispatchDashboardScanStart(payload) {
    return postJsonToCandidateEndpoints(
      [
        window.NEON_SCAN_ENDPOINTS?.start,
        window.NEON_SCAN_ENDPOINTS?.execute,
        window.NEON_DATA_ENDPOINTS?.scanStart,
        "/api/scan/start",
        "/api/scan/execute"
      ],
      payload
    );
  }

  async function pollDashboardScanStatus(params) {
    const runId = String(params?.runId || "").trim();
    if (!isFilled(runId)) {
      return;
    }

    const pollIntervalMs = 2000;
    const maxAttempts = 1800;
    const statusCandidates = [
      params?.statusUrl,
      window.NEON_SCAN_ENDPOINTS?.status,
      window.NEON_DATA_ENDPOINTS?.scanStatus,
      `/api/scan/status?runId=${encodeURIComponent(runId)}`
    ]
      .filter(Boolean)
      .map((url) => withRunIdQuery(url, runId));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const statusResponse = await fetchJsonFromCandidateEndpoints(statusCandidates);

      if (!statusResponse || !statusResponse.body || typeof statusResponse.body !== "object") {
        if (attempt === 0) {
          setDashboardSourceStatus(`Scan ${runId} status endpoint unavailable.`, "error");
          return;
        }
        await wait(pollIntervalMs);
        continue;
      }

      const state = String(statusResponse.body.state || statusResponse.body.status || "").toLowerCase();
      const progress = statusResponse.body.progress && typeof statusResponse.body.progress === "object"
        ? statusResponse.body.progress
        : {};
      const completed = Math.max(0, Number(progress.completed) || 0);
      const total = Math.max(0, Number(progress.total) || 0);
      const failed = Math.max(0, Number(progress.failed) || 0);
      const review = Math.max(0, Number(progress.review) || 0);

      if (state === "queued") {
        setDashboardSourceStatus(`Scan ${runId} queued...`, "info");
      } else if (state === "running") {
        if (total > 0) {
          setDashboardSourceStatus(
            `Scan ${runId}: ${completed}/${total} checks processed (${failed} fail, ${review} review).`,
            "info"
          );
        } else {
          setDashboardSourceStatus(`Scan ${runId} is running...`, "info");
        }
      } else if (state === "completed") {
        const reportPageUrl = `../scan-report/index.html?runId=${encodeURIComponent(runId)}`;
        mergeScanContext({
          runId,
          latestRunId: runId,
          scanStatusUrl: firstFilled(params?.statusUrl),
          scanReportUrl: firstFilled(params?.reportUrl),
          scanState: "completed"
        });
        setDashboardSourceStatus(`Scan ${runId} completed. Opening report...`, "success");
        window.setTimeout(() => {
          window.location.href = reportPageUrl;
        }, 400);
        return;
      } else if (state === "failed") {
        const errorMessage = firstFilled(statusResponse.body.error, `Scan ${runId} failed.`);
        mergeScanContext({
          runId,
          latestRunId: runId,
          scanState: "failed"
        });
        setDashboardSourceStatus(errorMessage, "error");
        return;
      }

      await wait(pollIntervalMs);
    }

    setDashboardSourceStatus(`Scan ${runId} status polling timed out. Open report manually.`, "error");
  }

  async function fetchJsonFromCandidateEndpoints(candidates) {
    const uniqueCandidates = [...new Set(toArray(candidates).filter(Boolean))];
    for (const url of uniqueCandidates) {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          headers: {
            Accept: "application/json"
          }
        });
        if (!response.ok) {
          continue;
        }
        const contentType = response.headers.get("content-type") || "";
        const payload = contentType.includes("application/json")
          ? await response.json()
          : { message: await response.text() };
        return {
          url,
          body: payload
        };
      } catch (_error) {
        // Try next endpoint.
      }
    }

    return null;
  }

  async function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function postJsonToCandidateEndpoints(candidates, body) {
    const uniqueCandidates = [...new Set(toArray(candidates).filter(Boolean))];
    for (const url of uniqueCandidates) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          continue;
        }

        const contentType = response.headers.get("content-type") || "";
        const payload = contentType.includes("application/json")
          ? await response.json()
          : { message: await response.text() };
        return {
          url,
          body: payload
        };
      } catch (_error) {
        // Try next endpoint.
      }
    }
    return null;
  }

  function isGitHubRepoUrl(value) {
    if (!isFilled(value)) {
      return false;
    }
    const pattern = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?\/?$/i;
    return pattern.test(String(value).trim());
  }

  function extractRepoNameFromGitHubUrl(value) {
    if (!isFilled(value)) {
      return "";
    }
    try {
      const parsed = new URL(String(value).trim());
      if (!parsed.hostname.toLowerCase().includes("github.com")) {
        return "";
      }
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length < 2) {
        return "";
      }
      return normalizeRepoName(segments[1].replace(/\.git$/i, ""));
    } catch (_error) {
      return "";
    }
  }

  function getPathBasename(pathValue) {
    if (!isFilled(pathValue)) {
      return "";
    }
    const normalized = String(pathValue).trim().replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : "";
  }

  function setDashboardSourceStatus(message, tone) {
    const status = byId("dashboard-source-status");
    if (!status) {
      return;
    }

    status.textContent = isFilled(message) ? String(message) : "Source status unavailable";
    status.classList.remove("text-text-muted", "text-primary", "text-success", "text-critical");

    if (tone === "success") {
      status.classList.add("text-success");
      return;
    }
    if (tone === "error") {
      status.classList.add("text-critical");
      return;
    }
    if (tone === "info") {
      status.classList.add("text-primary");
      return;
    }
    status.classList.add("text-text-muted");
  }

  function firstFilled(...values) {
    for (const value of values) {
      if (isFilled(value)) {
        return String(value).trim();
      }
    }
    return "";
  }

  function renderCodex(data) {
    if (!data || typeof data !== "object") {
      return;
    }

    const systemStatus = toUpper(data.systemStatus);
    if (systemStatus) {
      setText("codex-system-status", `SYSTEM_STATUS: ${systemStatus}`);
    }
    if (isFilled(data.uptime)) {
      setText("codex-uptime", data.uptime);
    }
    if (isFilled(data.version)) {
      setText("codex-version", data.version);
    }

    const activeFrameworks = toArray(data.activeFrameworks);
    if (activeFrameworks.length > 0) {
      setText("codex-framework-count", String(activeFrameworks.length).padStart(2, "0"));
    }

    const frameworkList = byId("codex-framework-list");
    if (frameworkList && activeFrameworks.length > 0) {
      frameworkList.innerHTML = activeFrameworks
        .map((framework) => {
          const active = framework.active !== false;
          const rowClass = active
            ? "flex items-center justify-between group cursor-pointer"
            : "flex items-center justify-between group cursor-pointer opacity-40 hover:opacity-100 transition-opacity";
          const dotClass = active ? "w-1.5 h-1.5 bg-primary rounded-full shadow-glow" : "w-1.5 h-1.5 bg-border-dark rounded-full";
          const nameClass = active
            ? "text-xs font-mono text-white group-hover:text-primary transition-colors"
            : "text-xs font-mono text-text-muted line-through group-hover:text-white group-hover:no-underline transition-colors";

          return `
            <div class="${rowClass}">
              <div class="flex items-center gap-3">
                <div class="${dotClass}"></div>
                <span class="${nameClass}">${escapeHtml(framework.name || "UNKNOWN")}</span>
              </div>
              <span class="text-[10px] text-text-muted font-mono">${escapeHtml(framework.version || (active ? "ACTIVE" : "OFF"))}</span>
            </div>
          `;
        })
        .join("");
    }

    if (isFilled(data.selectedFramework)) {
      setText("codex-selected-framework", data.selectedFramework);
    }

    if (data.operator && typeof data.operator === "object") {
      if (isFilled(data.operator.name)) {
        setText("codex-operator-name", data.operator.name);
      }
      if (isFilled(data.operator.avatar)) {
        const avatar = byId("codex-operator-avatar");
        if (avatar) {
          avatar.style.backgroundImage = `url("${data.operator.avatar}")`;
        }
      }
    }

    const library = toArray(data.library);
    const libraryList = byId("codex-library-list");
    if (libraryList && library.length > 0) {
      libraryList.innerHTML = library
        .map((item) => {
          const selected = item.selected === true;
          if (selected) {
            return `
              <button class="w-full text-left group flex items-center justify-between px-4 py-3 bg-primary text-background-dark font-bold border border-primary relative overflow-hidden">
                <div class="flex items-center gap-3 relative z-10">
                  <span class="material-symbols-outlined text-[18px]">folder_open</span>
                  <span class="tracking-wide text-sm font-mono">${escapeHtml(item.name || "Unnamed")}</span>
                </div>
                <div class="absolute top-0 right-0 size-2 bg-background-dark transform rotate-45 translate-x-1.5 -translate-y-1.5"></div>
              </button>
            `;
          }

          return `
            <button class="w-full text-left group flex items-center justify-between px-4 py-3 hover:bg-white/5 text-text-muted hover:text-primary transition-all border border-transparent hover:border-border-dark">
              <div class="flex items-center gap-3">
                <span class="material-symbols-outlined text-[18px]">folder</span>
                <span class="tracking-wide text-sm font-mono">${escapeHtml(item.name || "Unnamed")}</span>
              </div>
            </button>
          `;
        })
        .join("");
    }

    if (isFilled(data.lastSync)) {
      setText("codex-last-sync", data.lastSync);
    }

    if (data.activeRuleset && typeof data.activeRuleset === "object") {
      if (isFilled(data.activeRuleset.title)) {
        setText("codex-ruleset-title", data.activeRuleset.title);
      }
      if (isFilled(data.activeRuleset.description)) {
        setText("codex-ruleset-description", data.activeRuleset.description);
      }

      const status = toUpper(data.activeRuleset.status || "ENFORCED");
      const statusElement = byId("codex-ruleset-status");
      if (statusElement) {
        statusElement.innerHTML = `<span class="w-1.5 h-1.5 bg-primary rounded-full animate-pulse"></span>STATUS: ${escapeHtml(status)}`;
      }

      if (Number.isFinite(Number(data.activeRuleset.mandates))) {
        setText("codex-mandates-count", `${Number(data.activeRuleset.mandates)} MANDATES`);
      }
    }

    const sections = toArray(data.mandateSections);
    const sectionsRoot = byId("codex-mandates-sections");
    if (sectionsRoot && sections.length > 0) {
      sectionsRoot.innerHTML = sections
        .map((section, index) => renderCodexSection(section, index))
        .join("");
    }
  }

  function renderScanReport(data) {
    if (!data || typeof data !== "object") {
      return;
    }

    const systemStatus = toUpper(data.systemStatus);
    if (systemStatus) {
      setText("scan-system-status", systemStatus);
    }

    const health = Math.max(0, Math.min(100, Number(data.health)));
    const healthBar = byId("scan-system-health-bar");
    if (healthBar && Number.isFinite(health)) {
      healthBar.style.width = `${health}%`;
    }

    if (isFilled(data.cpu)) {
      setText("scan-cpu", `CPU: ${data.cpu}`);
    }
    if (isFilled(data.memory)) {
      setText("scan-memory", `MEM: ${data.memory}`);
    }

    const frameworkList = byId("scan-framework-list");
    const frameworks = toArray(data.frameworks);
    if (frameworkList && frameworks.length > 0) {
      frameworkList.innerHTML = frameworks
        .map((framework) => {
          const enabled = framework.enabled !== false;
          const nameClass = enabled
            ? "text-xs font-mono text-white group-hover:text-primary transition-colors"
            : "text-xs font-mono text-text-muted group-hover:text-primary transition-colors";

          return `
            <label class="flex items-center justify-between cursor-pointer group">
              <span class="${nameClass}">${escapeHtml(framework.name || "UNKNOWN")}</span>
              <input ${enabled ? "checked" : ""} class="form-checkbox h-3 w-3 text-primary bg-background border-border rounded-none focus:ring-0 focus:ring-offset-0" type="checkbox"/>
            </label>
          `;
        })
        .join("");
    }

    if (isFilled(data.repo)) {
      setText("scan-repo", data.repo);
    }
    if (isFilled(data.ref)) {
      setText("scan-ref", data.ref);
    }
    if (isFilled(data.reportId)) {
      setText("scan-report-id", data.reportId);
    }

    const failedMandates = toArray(data.failedMandates);
    const reviewMandates = toArray(data.reviewMandates);
    const rawPassRate = Number(data.passRate);
    const passRate = Number.isFinite(rawPassRate) ? Math.max(0, Math.min(100, rawPassRate)) : NaN;
    const rawFailCount = Number(data.fail);
    const derivedFailCount = Number.isFinite(rawFailCount) ? Math.max(0, Math.round(rawFailCount)) : failedMandates.length;
    const rawReviewCount = Number(data.review);
    const derivedReviewCount = Number.isFinite(rawReviewCount) ? Math.max(0, Math.round(rawReviewCount)) : reviewMandates.length;

    const bannerTone = getTone(
      data.severity || data.status || (derivedFailCount > 0 ? "critical" : derivedReviewCount > 0 ? "warning" : "success")
    );
    styleScanBanner(bannerTone);

    const computedTitle = buildScanStatusTitle(data, failedMandates, derivedFailCount, derivedReviewCount);
    if (isFilled(computedTitle)) {
      setText("scan-status-title", computedTitle);
    }

    const computedSubtitle = buildScanStatusSubtitle(data, derivedFailCount, derivedReviewCount, passRate);
    if (isFilled(computedSubtitle)) {
      setText("scan-status-subtitle", computedSubtitle);
    }

    startLiveTimestampClock("scan-timestamp");

    if (Number.isFinite(passRate)) {
      setText("scan-pass-rate", `${Math.round(passRate)}%`);
      const circle = byId("scan-pass-rate-circle");
      if (circle) {
        const radius = 45;
        const circumference = 2 * Math.PI * radius;
        const fillAmount = (passRate / 100) * circumference;
        circle.setAttribute("stroke", bannerTone.hex);
        circle.setAttribute("stroke-dasharray", `${fillAmount} ${circumference}`);
      }
    }

    if (Number.isFinite(Number(data.success))) {
      setText("scan-success-count", String(data.success));
    }
    setText("scan-fail-count", String(derivedFailCount).padStart(2, "0"));

    const severityIndex = toArray(data.severityIndex);
    const severityIndexRoot = byId("scan-severity-index");
    if (severityIndexRoot && severityIndex.length > 0) {
      severityIndexRoot.innerHTML = severityIndex
        .map((item) => {
          const tone = getTone(item.severity || item.label);
          const pct = Math.max(0, Math.min(100, Number(item.percent)));
          return `
            <div class="space-y-1">
              <div class="flex items-center justify-between text-[11px] font-mono">
                <span class="${tone.textClass}">${escapeHtml(item.label || "SEVERITY")}</span>
                <span class="text-white">${escapeHtml(item.count ?? "0")}</span>
              </div>
              <div class="w-full bg-border h-1.5">
                <div class="${tone.bgClass} h-1.5" style="width: ${pct}%"></div>
              </div>
            </div>
          `;
        })
        .join("");
    }

    const failedRoot = byId("scan-failed-mandates-list");
    if (failedRoot) {
      if (failedMandates.length > 0 || reviewMandates.length > 0) {
        failedRoot.innerHTML = [...failedMandates, ...reviewMandates].map((item) => renderFailedMandate(item)).join("");
      } else {
        failedRoot.innerHTML = `
          <div class="border border-success bg-surface/30 p-6 text-center font-mono text-sm text-success">
            NO FAILED OR REVIEW MANDATES
          </div>
        `;
      }
    }

    const passedChecks = toArray(data.passedChecks);
    setText("scan-passed-count", String(passedChecks.length));

    const passedRoot = byId("scan-passed-list");
    if (passedRoot) {
      if (passedChecks.length > 0) {
        const overflow = Number.isFinite(Number(data.passedOverflow)) ? Number(data.passedOverflow) : 0;
        passedRoot.innerHTML = `${passedChecks
          .map(
            (item) => `
              <div class="bg-surface/30 border border-border p-3 flex items-center justify-between hover:border-primary/50 transition-colors cursor-pointer">
                <div class="flex flex-col">
                <span class="text-[9px] text-text-muted font-mono font-bold">${escapeHtml(item.code || "UNKNOWN")}</span>
                <span class="text-[11px] text-white font-mono uppercase">${escapeHtml(item.title || "Untitled Check")}</span>
              </div>
                <span class="material-symbols-outlined text-success text-[18px]">check</span>
              </div>
            `
          )
          .join("")}
          ${
            overflow > 0
              ? `<div class="text-center py-3 text-[10px] font-mono text-text-muted border border-border border-dashed hover:text-white transition-colors cursor-pointer uppercase">+ ${overflow} more compliant mandates</div>`
              : ""
          }`;
      } else {
        passedRoot.innerHTML = `
          <div class="text-center py-3 text-[10px] font-mono text-text-muted border border-border border-dashed uppercase">
            NO PASSED MANDATES IN THIS RUN
          </div>
        `;
      }
    }

    const notApplicable = toArray(data.notApplicable);
    setText("scan-not-applicable-count", String(notApplicable.length));

    const notApplicableRoot = byId("scan-not-applicable-list");
    if (notApplicableRoot) {
      if (notApplicable.length > 0) {
        notApplicableRoot.innerHTML = notApplicable
          .map(
            (item, index) => `
              <div class="flex items-center justify-between text-[11px] font-mono text-text-muted">
                <span class="uppercase">${escapeHtml(item.name || "N/A")}</span>
                <span class="text-[9px] px-1 border border-text-muted">N/A</span>
              </div>
              ${index < notApplicable.length - 1 ? '<div class="w-full h-px bg-border"></div>' : ""}
            `
          )
          .join("");
      } else {
        notApplicableRoot.innerHTML = `
          <div class="flex items-center justify-between text-[11px] font-mono text-text-muted">
            <span class="uppercase">NONE</span>
            <span class="text-[9px] px-1 border border-text-muted">N/A</span>
          </div>
        `;
      }
    }

    if (isFilled(data.sessionToken)) {
      setText("scan-session-token", data.sessionToken);
    }
    if (isFilled(data.node)) {
      setText("scan-node", data.node);
    }

    const storedContext = getStoredScanContext();
    if (isFilled(data.reportId)) {
      mergeScanContext({
        runId: String(data.reportId),
        latestRunId: String(data.reportId)
      });
    }
    const repoFromScanReport = normalizeRepoName(data.repo || byId("scan-repo")?.textContent);
    const preferredRepo = isFilled(data.sessionId)
      ? repoFromScanReport
      : normalizeRepoName(storedContext.repo) || repoFromScanReport;
    applyHeaderScanContext("scan-repo", "scan-session-id", preferredRepo, data.sessionId, false);
  }

  function buildScanStatusTitle(data, failedMandates, failCount, reviewCount) {
    if (isFilled(data.statusTitle)) {
      return String(data.statusTitle);
    }

    const criticalCount = failedMandates.filter((item) => String(item?.severity || "").toLowerCase().includes("critical")).length;
    if (failCount <= 0 && reviewCount <= 0) {
      return "COMPLIANCE CHECKS PASSED";
    }
    if (failCount <= 0 && reviewCount > 0) {
      return `${reviewCount} MANDATES REQUIRE REVIEW`;
    }
    if (criticalCount > 0) {
      return "CRITICAL MANDATES REQUIRE ACTION";
    }
    if (failCount > 0) {
      return `${failCount} MANDATES FAILED`;
    }
    return "LIVE COMPLIANCE POSTURE";
  }

  function buildScanStatusSubtitle(data, failCount, reviewCount, passRate) {
    const openCount = Math.max(0, failCount) + Math.max(0, reviewCount);
    const result = toUpper(data.result || (openCount > 0 ? "MANDATE_GAPS_FOUND" : "ALL_CHECKS_PASSED"));
    const action = toUpper(
      data.action || (failCount > 0 ? "REMEDIATION_IN_PROGRESS" : reviewCount > 0 ? "REVIEW_EVIDENCE_REQUESTS" : "CONTINUOUS_MONITORING")
    );
    const passRateToken = Number.isFinite(passRate) ? `${Math.round(passRate)}%` : "--";
    return `// RESULT: ${result} // FAIL: ${failCount} // REVIEW: ${reviewCount} // OPEN_MANDATES: ${openCount} // PASS_RATE: ${passRateToken} // ${action}`;
  }

  function startLiveTimestampClock(elementId) {
    const timestampNode = byId(elementId);
    if (!timestampNode) {
      return;
    }

    const updateTimestamp = () => {
      timestampNode.textContent = formatUtcTimestamp(new Date());
    };

    if (!timestampNode.dataset.liveClockBound) {
      timestampNode.dataset.liveClockBound = "1";
      window.setInterval(updateTimestamp, 1000);
    }

    updateTimestamp();
  }

  function renderCodexSection(section, index) {
    const sectionLabel = `${String(index + 1).padStart(2, "0")} // ${escapeHtml(section.title || "SECTION")}`;
    const muted = section.muted === true;
    const sectionClass = muted
      ? "text-text-muted font-mono font-bold text-lg opacity-60"
      : "text-primary font-mono font-bold text-lg";

    const items = toArray(section.items);

    return `
      <div class="flex items-center gap-4 py-4 ${index > 0 ? "mt-8" : "mt-2"}">
        <span class="${sectionClass}">${sectionLabel}</span>
        <div class="h-px bg-border-dark flex-1"></div>
      </div>
      ${items.map((item) => renderCodexMandate(item)).join("")}
    `;
  }

  function renderCodexMandate(item) {
    const tone = getTone(item.status);
    const badge = toUpper(item.status || "UNKNOWN");
    const expanded = item.expanded === true;

    return `
      <div class="border ${tone.borderClass} bg-surface-dark relative group transition-all ${expanded ? "overflow-hidden" : ""}">
        <div class="absolute top-0 bottom-0 left-0 w-1 ${tone.bgClass}"></div>
        <div class="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 cursor-pointer hover:bg-white/5 transition-colors">
          <div class="flex items-start md:items-center gap-5">
            <button class="border border-border-dark size-6 flex items-center justify-center text-text-muted hover:text-white hover:border-white transition-all bg-background-dark">
              <span class="material-symbols-outlined text-base">${expanded ? "remove" : "add"}</span>
            </button>
            <div>
              <div class="flex items-center gap-3 mb-1">
                <span class="font-mono ${tone.textClass} font-bold text-sm">${escapeHtml(item.id || "MANDATE")}</span>
                <span class="${tone.badgeClass} text-[10px] px-1.5 py-0.5 font-bold border ${tone.badgeBorderClass} font-mono">${escapeHtml(badge)}</span>
              </div>
              <h4 class="text-white font-bold text-lg tracking-wide font-display">${escapeHtml(item.title || "Untitled Mandate")}</h4>
            </div>
          </div>
          <div class="flex items-center gap-6 pr-2">
            <div class="text-right hidden sm:block">
              <div class="text-[10px] text-text-muted font-mono">LAST SCAN</div>
              <div class="text-xs text-white font-mono">${escapeHtml(item.lastScan || "N/A")}</div>
            </div>
            <div class="size-3 rounded-full ${tone.bgClass} ${tone.glowClass}"></div>
          </div>
        </div>
        ${expanded ? renderCodexExpanded(item) : ""}
      </div>
    `;
  }

  function renderCodexExpanded(item) {
    const details = item.details && typeof item.details === "object" ? item.details : {};
    const evidence = toArray(details.evidence);

    return `
      <div class="px-5 pb-5 pl-[4.25rem] pr-8 border-t border-border-dark/50 pt-5 bg-black/30">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div class="md:col-span-2 space-y-4">
            <p class="text-text-main text-sm leading-relaxed font-mono opacity-90">${escapeHtml(details.description || item.description || "")}</p>
            <div class="bg-background-dark border border-border-dark p-3">
              <div class="flex items-center justify-between mb-2 border-b border-border-dark pb-2">
                <span class="text-[10px] text-text-muted font-bold tracking-wider font-mono">EVIDENCE_LOG</span>
                <span class="text-[10px] text-primary font-mono font-bold">${escapeHtml(toUpper(details.evidenceStatus || "VERIFIED"))}</span>
              </div>
              <div class="font-mono text-xs text-text-muted font-light">
                ${
                  evidence.length > 0
                    ? evidence
                        .map((line) => `<span class="text-primary">&gt;</span> ${escapeHtml(line)}<br/>`)
                        .join("")
                    : '<span class="text-primary">&gt;</span> No evidence records found.<br/>'
                }
              </div>
            </div>
          </div>
          <div class="md:col-span-1 border-l border-border-dark pl-6 flex flex-col gap-4">
            <div>
              <span class="text-[10px] text-text-muted font-bold block mb-1 font-mono">CATEGORY</span>
              <span class="text-sm text-white font-mono">${escapeHtml(details.category || item.category || "Unspecified")}</span>
            </div>
            <div>
              <span class="text-[10px] text-text-muted font-bold block mb-1 font-mono">PRIORITY</span>
              <span class="text-sm text-white font-mono">${escapeHtml(details.priority || item.priority || "P2 - Medium")}</span>
            </div>
            <button class="mt-2 w-full py-2 border border-border-dark hover:border-text-main text-xs font-bold text-text-main hover:bg-white/5 transition-all flex items-center justify-center gap-2 font-mono">
              <span class="material-symbols-outlined text-[16px]">visibility</span>
              VIEW DETAILS
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderFailedMandate(item) {
    const tone = getTone(item.severity || "critical");
    const mandateLink = isFilled(item.documentationUrl) ? item.documentationUrl : "../compliance-codex/index.html";

    return `
      <div class="border ${tone.borderClass} bg-surface/50 relative group">
        <div class="p-6">
          <div class="flex justify-between items-start mb-4">
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-3">
                <span class="${tone.bgClass} text-black text-[10px] font-mono font-bold px-2 py-0.5">${escapeHtml(toUpper(item.severity || "HIGH"))}</span>
                <span class="text-white font-mono font-bold text-lg tracking-tight">${escapeHtml(item.code || "MANDATE")}</span>
              </div>
              <div class="flex flex-col">
                <h4 class="text-lg text-white font-mono font-bold uppercase leading-tight">${escapeHtml(item.title || "Issue")}</h4>
                <p class="text-[11px] text-text-muted font-mono mt-1">DOC: ${escapeHtml(item.document || "N/A")} // SECTION: ${escapeHtml(item.section || "N/A")}</p>
              </div>
            </div>
            <span class="material-symbols-outlined ${tone.textClass}/30 group-hover:${tone.textClass} transition-colors text-3xl">${escapeHtml(item.icon || "report")}</span>
          </div>
          <div class="bg-background border-l-2 ${tone.borderClass} p-4 mb-6">
            <div class="font-mono text-sm text-text-main leading-relaxed">
              <span class="${tone.textClass} opacity-50">&gt;</span> ${escapeHtml(item.violation || "Violation details unavailable.")}<br/>
              <span class="${tone.textClass} opacity-50">&gt;</span> ${escapeHtml(item.required || "Mitigation details unavailable.")}
            </div>
          </div>
          <div class="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t border-border border-dashed">
            <div class="flex items-center gap-2 text-text-muted hover:text-white transition-colors cursor-pointer">
              <span class="material-symbols-outlined text-sm">info</span>
              <span class="text-[10px] font-mono uppercase">Internal Reference ID: ${escapeHtml(item.reference || "N/A")}</span>
            </div>
            <a class="w-full sm:w-auto px-6 py-2 border ${tone.borderClass} ${tone.textClass} text-xs font-bold font-mono hover:${tone.bgClass} hover:text-black transition-all text-center uppercase tracking-widest" href="${escapeHtml(mandateLink)}">
              [ VIEW MANDATE DOCUMENTATION ]
            </a>
          </div>
        </div>
      </div>
    `;
  }

  function styleScanBanner(tone) {
    const banner = byId("scan-banner");
    const stripe = byId("scan-banner-stripe");
    const title = byId("scan-status-title");
    const subtitle = byId("scan-status-subtitle");

    if (banner) {
      banner.classList.remove(
        "border-critical",
        "bg-critical/5",
        "border-warning",
        "bg-warning/5",
        "border-success",
        "bg-success/5",
        "border-primary",
        "bg-primary/5"
      );
      banner.classList.add(tone.borderClass, tone.bannerBgClass);
    }

    if (stripe) {
      stripe.classList.remove("bg-critical", "bg-warning", "bg-success", "bg-primary");
      stripe.classList.add(tone.bgClass);
    }

    if (title) {
      title.classList.remove("text-critical", "text-warning", "text-success", "text-primary");
      title.classList.add(tone.textClass);
    }

    if (subtitle) {
      subtitle.classList.remove("text-critical/70", "text-warning/70", "text-success/70", "text-primary/70");
      subtitle.classList.add(tone.subtitleClass);
    }
  }

  function getTone(value) {
    const token = String(value || "").toLowerCase();

    if (token.includes("critical") || token.includes("fail") || token.includes("blocker")) {
      return {
        textClass: "text-critical",
        bgClass: "bg-critical",
        borderClass: "border-critical",
        badgeClass: "bg-critical/20 text-critical",
        badgeBorderClass: "border-critical/30",
        subtitleClass: "text-critical/70",
        bannerBgClass: "bg-critical/5",
        glowClass: "shadow-glow-critical",
        hex: "#EF4444"
      };
    }

    if (token.includes("warn") || token.includes("review") || token.includes("high")) {
      return {
        textClass: "text-warning",
        bgClass: "bg-warning",
        borderClass: "border-warning",
        badgeClass: "bg-warning/20 text-warning",
        badgeBorderClass: "border-warning/30",
        subtitleClass: "text-warning/70",
        bannerBgClass: "bg-warning/5",
        glowClass: "",
        hex: "#FACC15"
      };
    }

    if (token.includes("pass") || token.includes("success") || token.includes("compliant") || token.includes("resolved")) {
      return {
        textClass: "text-success",
        bgClass: "bg-success",
        borderClass: "border-success",
        badgeClass: "bg-success/20 text-success",
        badgeBorderClass: "border-success/30",
        subtitleClass: "text-success/70",
        bannerBgClass: "bg-success/5",
        glowClass: "",
        hex: "#22C55E"
      };
    }

    return {
      textClass: "text-primary",
      bgClass: "bg-primary",
      borderClass: "border-primary",
      badgeClass: "bg-primary/20 text-primary",
      badgeBorderClass: "border-primary/30",
      subtitleClass: "text-primary/70",
      bannerBgClass: "bg-primary/5",
      glowClass: "shadow-glow",
      hex: "#22D3EE"
    };
  }

  function getStatusTextClass(status) {
    const token = String(status || "").toLowerCase();
    if (token.includes("critical") || token.includes("fail")) {
      return "text-critical";
    }
    if (token.includes("standby") || token.includes("review") || token.includes("warn")) {
      return "text-warning";
    }
    if (token.includes("pass") || token.includes("success") || token.includes("ready") || token.includes("online") || token.includes("ok")) {
      return "text-success";
    }
    return "text-text-muted";
  }

  function getLogLevelClass(level) {
    const token = String(level || "").toLowerCase();
    if (token.includes("critical") || token.includes("error") || token.includes("alert")) {
      return "text-critical";
    }
    if (token.includes("warn")) {
      return "text-warning";
    }
    if (token.includes("pass") || token.includes("success") || token.includes("ok")) {
      return "text-success";
    }
    return "text-primary";
  }

  function normalizeTime(raw) {
    if (!isFilled(raw)) {
      return "--:--:--";
    }
    return String(raw).replace(/^\[|\]$/g, "").trim();
  }

  function formatUtcTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
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

  function setText(id, value) {
    const node = byId(id);
    if (!node || !isFilled(value)) {
      return;
    }
    node.textContent = String(value);
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function toUpper(value) {
    return isFilled(value) ? String(value).toUpperCase() : "";
  }

  function isFilled(value) {
    return value !== null && value !== undefined && String(value).trim() !== "";
  }

  function getPositiveNumber(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) {
        return number;
      }
    }
    return 30000;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
