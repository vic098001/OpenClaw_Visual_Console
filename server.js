const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");

const PORT = Number(process.env.PORT || 4173);
const HOST = String(process.env.HOST || "127.0.0.1").trim();
const PUBLIC_DIR = path.join(__dirname, "public");
const COMMAND_TIMEOUT_MS = 45000;
const REMOTE_FETCH_TIMEOUT_MS = Number(process.env.REMOTE_FETCH_TIMEOUT_MS || 15000);
const DASH_TOKEN = String(process.env.OPENCLAW_DASH_TOKEN || "").trim();
const INCLUDE_LOCAL_SOURCE = process.env.OPENCLAW_INCLUDE_LOCAL_SOURCE !== "0";
const DEFAULT_SOURCE_ID = String(process.env.OPENCLAW_DEFAULT_SOURCE || "local").trim();
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX || 60);
const rateBuckets = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX_REQUESTS;
}

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [ip, bucket] of rateBuckets.entries()) {
    if (bucket.windowStart < cutoff) {
      rateBuckets.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const CSP_HTML =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com data:; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'";

function setSecurityHeaders(res, { isHtml = false } = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  if (isHtml) {
    res.setHeader("Content-Security-Policy", CSP_HTML);
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  }
}

function toSafeSourceId(raw, fallback) {
  const source = String(raw || fallback || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return source || String(fallback || "source");
}

function parseRemoteSources(rawJson) {
  const sourceText = String(rawJson || "").trim();
  if (!sourceText) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(sourceText);
  } catch (error) {
    throw new Error(`OPENCLAW_REMOTE_SOURCES must be a JSON array: ${formatError(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("OPENCLAW_REMOTE_SOURCES must be a JSON array.");
  }

  const output = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];
    if (!item || typeof item !== "object") {
      continue;
    }

    const id = toSafeSourceId(item.id, `remote-${index + 1}`);
    const url = String(item.url || "").trim();
    if (!url) {
      continue;
    }

    const tokenFromEnvName = String(item.tokenEnv || "").trim();
    const tokenFromEnv = tokenFromEnvName ? String(process.env[tokenFromEnvName] || "").trim() : "";
    const token = tokenFromEnv || String(item.token || "").trim();

    const timeoutMsRaw = Number(item.timeoutMs || REMOTE_FETCH_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : REMOTE_FETCH_TIMEOUT_MS;

    output.push({
      id,
      label: String(item.label || id).trim(),
      mode: "remote",
      url,
      token,
      timeoutMs
    });
  }

  return output;
}

function buildSources() {
  const sources = [];

  if (INCLUDE_LOCAL_SOURCE) {
    sources.push({
      id: "local",
      label: "本地 OpenClaw",
      mode: "local"
    });
  }

  const remoteSources = parseRemoteSources(process.env.OPENCLAW_REMOTE_SOURCES || "");
  sources.push(...remoteSources);

  if (!sources.length) {
    throw new Error("No telemetry sources configured. Enable local source or set OPENCLAW_REMOTE_SOURCES.");
  }

  return sources;
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || String(error);
}

function sanitizeErrorForClient(message) {
  const raw = String(message || "Unknown error");
  const cleaned = raw
    .replace(/\/[^\s:]+\//g, "<path>/")
    .replace(/at\s+\S+\s+\([^)]+\)/g, "")
    .trim();
  return cleaned.slice(0, 200) || "Internal error";
}

const TELEMETRY_SOURCES = buildSources();
const SOURCE_BY_ID = new Map(TELEMETRY_SOURCES.map((source) => [source.id, source]));
const RESOLVED_DEFAULT_SOURCE_ID = SOURCE_BY_ID.has(DEFAULT_SOURCE_ID)
  ? DEFAULT_SOURCE_ID
  : TELEMETRY_SOURCES[0].id;

function extractJsonPayload(rawOutput) {
  const source = String(rawOutput || "").trim();
  if (!source) {
    throw new Error("Command output is empty");
  }

  const objectIndex = source.indexOf("{");
  const arrayIndex = source.indexOf("[");
  const candidates = [objectIndex, arrayIndex].filter((value) => value >= 0);

  if (!candidates.length) {
    throw new Error("JSON payload was not found in command output");
  }

  const start = Math.min(...candidates);
  const opening = source[start];
  const closing = opening === "{" ? "}" : "]";
  const end = source.lastIndexOf(closing);

  if (end <= start) {
    throw new Error("JSON payload is malformed");
  }

  const jsonText = source.slice(start, end + 1);
  return JSON.parse(jsonText);
}

function runOpenClawCommand(args) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    execFile(
      "openclaw",
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const output = [stdout, stderr].filter(Boolean).join("\n");

        if (!output && error) {
          reject(new Error(formatError(error)));
          return;
        }

        try {
          const data = extractJsonPayload(output || stdout || stderr);
          resolve({
            data,
            durationMs,
            hadExecError: Boolean(error),
            execError: error ? formatError(error) : null
          });
        } catch (parseError) {
          if (error) {
            const fallbackMessage = String(stderr || stdout || formatError(error)).trim();
            reject(new Error(fallbackMessage || formatError(error)));
            return;
          }
          reject(
            new Error(
              `Failed to parse JSON from openclaw ${args.join(" ")}: ${formatError(parseError)}`
            )
          );
        }
      }
    );
  });
}

async function collectCommand(name, args) {
  try {
    const result = await runOpenClawCommand(args);
    return {
      name,
      ok: true,
      args,
      durationMs: result.durationMs,
      data: result.data,
      warning: result.execError
    };
  } catch (error) {
    return {
      name,
      ok: false,
      args,
      durationMs: null,
      data: null,
      error: formatError(error)
    };
  }
}

function parseSessionKey(key) {
  const rawKey = String(key || "");
  const parts = rawKey.split(":");
  const cronIndex = parts.indexOf("cron");
  const telegramIndex = parts.indexOf("telegram");
  const topicIndex = parts.indexOf("topic");

  if (cronIndex >= 0) {
    const cronId = parts[cronIndex + 1] || "unknown";
    const runIndex = parts.indexOf("run");
    if (runIndex >= 0) {
      return {
        type: "cron-run",
        label: `正在执行 Cron 子任务 ${cronId.slice(0, 8)}`,
        channel: "internal"
      };
    }
    return {
      type: "cron",
      label: `处理定时任务 ${cronId.slice(0, 8)}`,
      channel: "internal"
    };
  }

  if (telegramIndex >= 0) {
    const topicId = topicIndex >= 0 ? parts[topicIndex + 1] : null;
    return {
      type: "telegram",
      label: topicId ? `响应 Telegram Topic ${topicId}` : "响应 Telegram 消息",
      channel: "telegram"
    };
  }

  if (rawKey.endsWith(":main")) {
    return {
      type: "direct",
      label: "处理主会话指令",
      channel: "direct"
    };
  }

  return {
    type: "other",
    label: rawKey || "未知任务",
    channel: "unknown"
  };
}

function buildSessionIndex(sessions) {
  const seen = new Set();
  const unique = [];

  for (const session of sessions || []) {
    const key = `${session.key || "no-key"}::${session.updatedAt || session.updatedAtMs || "0"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(session);
  }

  unique.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const byAgent = new Map();
  for (const session of unique) {
    const agentId = session.agentId || "unknown";
    if (!byAgent.has(agentId)) {
      byAgent.set(agentId, []);
    }
    byAgent.get(agentId).push(session);
  }

  return { unique, byAgent };
}

function classifyLiveState(lastActiveAgeMs, heartbeatEnabled) {
  if (typeof lastActiveAgeMs !== "number") {
    return heartbeatEnabled ? "IDLE" : "OFFLINE";
  }
  if (lastActiveAgeMs <= 2 * 60 * 1000) {
    return "RUNNING";
  }
  if (lastActiveAgeMs <= 15 * 60 * 1000) {
    return "ACTIVE";
  }
  return heartbeatEnabled ? "IDLE" : "OFFLINE";
}

function mapCronJobs(cronData) {
  const jobs = Array.isArray(cronData?.jobs) ? cronData.jobs : [];
  const now = Date.now();

  return jobs.map((job) => {
    const lastRunAtMs = job?.state?.lastRunAtMs || null;
    const lastDurationMs = job?.state?.lastDurationMs || null;
    const recentlyTriggered =
      typeof lastRunAtMs === "number" && now - lastRunAtMs <= Math.max(180000, (lastDurationMs || 0) + 60000);

    return {
      id: job.id || "unknown",
      name: job.name || "Unnamed job",
      agentId: job.agentId || "main",
      enabled: Boolean(job.enabled),
      scheduleExpr: job?.schedule?.expr || "n/a",
      scheduleTz: job?.schedule?.tz || "Asia/Hong_Kong",
      nextRunAtMs: job?.state?.nextRunAtMs || null,
      lastRunAtMs,
      lastRunStatus: job?.state?.lastRunStatus || "unknown",
      lastDurationMs,
      lastDelivered: Boolean(job?.state?.lastDelivered),
      runningNow: recentlyTriggered
    };
  });
}

function mapAgents(statusData, sessionsByAgent, heartbeatAgents, cronJobs) {
  const agentsFromStatus = Array.isArray(statusData?.agents?.agents) ? statusData.agents.agents : [];
  const heartbeatMap = new Map();

  for (const hb of heartbeatAgents || []) {
    heartbeatMap.set(hb.agentId, hb);
  }

  const agentIds = new Set();
  for (const agent of agentsFromStatus) {
    agentIds.add(agent.id);
  }
  for (const hb of heartbeatAgents || []) {
    agentIds.add(hb.agentId);
  }
  for (const [agentId] of sessionsByAgent.entries()) {
    agentIds.add(agentId);
  }

  const byId = new Map();
  for (const agent of agentsFromStatus) {
    byId.set(agent.id, agent);
  }

  const runningCronByAgent = new Map();
  for (const job of cronJobs) {
    if (job.runningNow) {
      if (!runningCronByAgent.has(job.agentId)) {
        runningCronByAgent.set(job.agentId, []);
      }
      runningCronByAgent.get(job.agentId).push(job);
    }
  }

  const result = [];
  for (const agentId of agentIds) {
    const fromStatus = byId.get(agentId) || {};
    const fromHeartbeat = heartbeatMap.get(agentId) || {};
    const sessions = sessionsByAgent.get(agentId) || [];
    const latestSession = sessions[0] || null;
    const sessionUpdatedAt = latestSession?.updatedAt || null;
    const statusUpdatedAt = fromStatus.lastUpdatedAt || null;
    const lastUpdatedAt = Math.max(sessionUpdatedAt || 0, statusUpdatedAt || 0) || null;

    const lastActiveAgeMs =
      typeof fromStatus.lastActiveAgeMs === "number"
        ? fromStatus.lastActiveAgeMs
        : lastUpdatedAt
          ? Date.now() - lastUpdatedAt
          : null;

    const heartbeatEnabled = Boolean(fromHeartbeat.enabled);
    const liveState = classifyLiveState(lastActiveAgeMs, heartbeatEnabled);
    const parsedSession = parseSessionKey(latestSession?.key || "");
    const runningJobs = runningCronByAgent.get(agentId) || [];
    const currentWork =
      runningJobs.length > 0
        ? `执行中: ${runningJobs[0].name}`
        : latestSession
          ? parsedSession.label
          : "等待新任务";

    result.push({
      id: agentId,
      name: fromStatus.name || agentId,
      workspaceDir: fromStatus.workspaceDir || null,
      bootstrapPending: Boolean(fromStatus.bootstrapPending),
      sessionsCount: typeof fromStatus.sessionsCount === "number" ? fromStatus.sessionsCount : sessions.length,
      heartbeatEnabled,
      heartbeatEvery: fromHeartbeat.every || "disabled",
      heartbeatEveryMs: fromHeartbeat.everyMs || null,
      lastUpdatedAt,
      lastActiveAgeMs,
      liveState,
      currentWork,
      activeJobCount: runningJobs.length,
      latestSession: latestSession
        ? {
            key: latestSession.key || null,
            model: latestSession.model || null,
            kind: latestSession.kind || null,
            updatedAt: latestSession.updatedAt || null,
            totalTokens: latestSession.totalTokens ?? null,
            inputTokens: latestSession.inputTokens ?? null,
            outputTokens: latestSession.outputTokens ?? null,
            percentUsed:
              typeof latestSession.percentUsed === "number" ? latestSession.percentUsed : null
          }
        : null
    });
  }

  const order = {
    RUNNING: 0,
    ACTIVE: 1,
    IDLE: 2,
    OFFLINE: 3
  };

  result.sort((a, b) => {
    const aRank = order[a.liveState] ?? 99;
    const bRank = order[b.liveState] ?? 99;
    if (aRank !== bRank) {
      return aRank - bRank;
    }
    return (a.lastActiveAgeMs || Number.MAX_SAFE_INTEGER) - (b.lastActiveAgeMs || Number.MAX_SAFE_INTEGER);
  });

  return result;
}

function mapActivityTimeline(sessions) {
  return (sessions || []).slice(0, 24).map((session) => {
    const parsed = parseSessionKey(session.key);
    return {
      agentId: session.agentId || "unknown",
      kind: session.kind || "direct",
      key: session.key || null,
      action: parsed.label,
      channel: parsed.channel,
      updatedAt: session.updatedAt || null,
      ageMs: session.ageMs || null,
      model: session.model || null,
      modelProvider: session.modelProvider || null,
      inputTokens: session.inputTokens ?? null,
      outputTokens: session.outputTokens ?? null,
      totalTokens: session.totalTokens ?? null,
      systemSent: Boolean(session.systemSent)
    };
  });
}

async function buildTelemetry() {
  // The OpenClaw CLI can emit non-JSON noise under concurrent invocations.
  // Collect sequentially for stable dashboard telemetry.
  const statusResult = await collectCommand("status", ["status", "--json"]);
  const sessionsResult = await collectCommand("sessions", ["sessions", "--json", "--all-agents"]);
  const cronResult = await collectCommand("cron", ["cron", "list", "--json"]);

  const now = Date.now();
  const errors = [statusResult, cronResult, sessionsResult]
    .filter((item) => !item.ok)
    .map((item) => `${item.name}: ${item.error}`);

  const warnings = [statusResult, cronResult, sessionsResult]
    .filter((item) => item.ok && item.warning)
    .map((item) => `${item.name}: ${item.warning}`);

  const statusData = statusResult.ok ? statusResult.data : {};
  const cronData = cronResult.ok ? cronResult.data : {};
  const sessionsData = sessionsResult.ok ? sessionsResult.data : {};

  const heartbeatAgents = Array.isArray(statusData?.heartbeat?.agents) ? statusData.heartbeat.agents : [];
  const sessionsFromCommand = Array.isArray(sessionsData?.sessions) ? sessionsData.sessions : [];
  const fallbackRecent = Array.isArray(statusData?.sessions?.recent) ? statusData.sessions.recent : [];

  const mergedSessions = sessionsFromCommand.length ? sessionsFromCommand : fallbackRecent;
  const { unique: uniqueSessions, byAgent: sessionsByAgent } = buildSessionIndex(mergedSessions);
  const cronJobs = mapCronJobs(cronData);
  const agents = mapAgents(statusData, sessionsByAgent, heartbeatAgents, cronJobs);
  const activity = mapActivityTimeline(uniqueSessions);

  const runningAgents = agents.filter((agent) => agent.liveState === "RUNNING").length;
  const activeAgents = agents.filter((agent) => agent.liveState === "RUNNING" || agent.liveState === "ACTIVE").length;
  const idleAgents = agents.filter((agent) => agent.liveState === "IDLE").length;
  const offlineAgents = agents.filter((agent) => agent.liveState === "OFFLINE").length;
  const enabledHeartbeatAgents = agents.filter((agent) => agent.heartbeatEnabled).length;

  const runningJobs = cronJobs.filter((job) => job.runningNow).length;
  const enabledJobs = cronJobs.filter((job) => job.enabled).length;

  return {
    meta: {
      generatedAt: now,
      partial: errors.length > 0,
      errors,
      warnings,
      commandLatencyMs: {
        status: statusResult.durationMs,
        cron: cronResult.durationMs,
        sessions: sessionsResult.durationMs
      }
    },
    summary: {
      totalAgents: agents.length,
      runningAgents,
      activeAgents,
      idleAgents,
      offlineAgents,
      enabledHeartbeatAgents,
      totalSessions: uniqueSessions.length,
      cronJobs: cronJobs.length,
      enabledCronJobs: enabledJobs,
      runningCronJobs: runningJobs
    },
    office: {
      label: "Skyline Penthouse Ops Deck",
      areaSqm: 200,
      levelHint: "Top Floor"
    },
    gateway: {
      reachable: statusData?.gateway?.reachable ?? null,
      url: statusData?.gateway?.url || null,
      connectLatencyMs: statusData?.gateway?.connectLatencyMs || null,
      runtimeShort: statusData?.gatewayService?.runtimeShort || null
    },
    agents,
    activity,
    cronJobs
  };
}

function extractAccessToken(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  const fallbackHeader = String(req.headers["x-dashboard-token"] || "").trim();
  if (fallbackHeader) {
    return fallbackHeader;
  }

  return "";
}

function secureTokenEqual(providedToken, expectedToken) {
  const provided = String(providedToken || "");
  const expected = String(expectedToken || "");
  if (!provided || !expected) {
    return false;
  }

  const digestProvided = crypto.createHash("sha256").update(provided).digest();
  const digestExpected = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(digestProvided, digestExpected);
}

function isAuthorized(req) {
  if (!DASH_TOKEN) {
    return true;
  }
  return secureTokenEqual(extractAccessToken(req), DASH_TOKEN);
}

function sendUnauthorized(res) {
  setSecurityHeaders(res);
  res.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Bearer realm="openclaw-dashboard"'
  });
  res.end(
    JSON.stringify(
      {
        ok: false,
        error: "Unauthorized",
        hint: "Provide Authorization: Bearer <OPENCLAW_DASH_TOKEN> or x-dashboard-token header"
      },
      null,
      2
    )
  );
}

function attachSourceMeta(payload, source, extra = {}) {
  const next = payload && typeof payload === "object" ? { ...payload } : {};
  next.source = {
    id: source.id,
    label: source.label,
    mode: source.mode,
    ...extra
  };
  return next;
}

async function fetchRemoteTelemetry(source) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutMs = source.timeoutMs || REMOTE_FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      Accept: "application/json"
    };
    if (source.token) {
      headers.Authorization = `Bearer ${source.token}`;
    }

    const response = await fetch(source.url, {
      method: "GET",
      cache: "no-store",
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Remote HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data || typeof data !== "object") {
      throw new Error("Remote payload is not valid JSON object");
    }

    const elapsed = Date.now() - startedAt;
    const nextMeta = {
      ...(data.meta || {}),
      proxyLatencyMs: elapsed
    };

    return attachSourceMeta(
      {
        ...data,
        meta: nextMeta
      },
      source,
      {
        fetchedAt: Date.now()
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function buildTelemetryForSource(source) {
  if (!source) {
    throw new Error("Unknown telemetry source");
  }

  if (source.mode === "remote") {
    return fetchRemoteTelemetry(source);
  }

  const localTelemetry = await buildTelemetry();
  return attachSourceMeta(localTelemetry, source, {
    fetchedAt: Date.now()
  });
}

function sendJson(req, res, statusCode, payload) {
  setSecurityHeaders(res);
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  compressAndSend(req, res, statusCode, headers, body);
}

function resolveStaticPath(requestPath) {
  if (requestPath.includes("\0")) {
    return null;
  }
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const normalizedPath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  const absolutePath = path.join(PUBLIC_DIR, normalizedPath);
  if (!absolutePath.startsWith(PUBLIC_DIR + path.sep) && absolutePath !== PUBLIC_DIR) {
    return null;
  }
  return absolutePath;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const filePath = resolveStaticPath(url.pathname);

  if (!filePath) {
    setSecurityHeaders(res);
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        setSecurityHeaders(res);
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      setSecurityHeaders(res);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === ".html";
    setSecurityHeaders(res, { isHtml });
    const headers = {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Cache-Control": isHtml ? "no-store" : "public, max-age=300"
    };
    const compressible = [".html", ".css", ".js", ".json", ".svg"];
    if (compressible.includes(ext)) {
      compressAndSend(req, res, 200, headers, content);
    } else {
      res.writeHead(200, headers);
      res.end(content);
    }
  });
}

function compressAndSend(req, res, statusCode, headers, body) {
  const acceptEncoding = String(req.headers["accept-encoding"] || "");
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    const raw = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
    if (raw.length > 860 && acceptEncoding.includes("gzip")) {
      zlib.gzip(raw, (err, compressed) => {
        if (err || !compressed) {
          res.writeHead(statusCode, headers);
          res.end(raw);
          return;
        }
        headers["Content-Encoding"] = "gzip";
        headers["Vary"] = "Accept-Encoding";
        res.writeHead(statusCode, headers);
        res.end(compressed);
      });
      return;
    }
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const clientIp = req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(clientIp)) {
    setSecurityHeaders(res);
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": "60"
    });
    res.end(JSON.stringify({ ok: false, error: "Too many requests" }));
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = requestUrl.pathname;

  if (req.method !== "GET" && req.method !== "HEAD") {
    setSecurityHeaders(res);
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  if (pathname === "/api/health") {
    sendJson(req, res, 200, {
      ok: true,
      time: Date.now()
    });
    return;
  }

  if (pathname === "/api/sources") {
    if (!isAuthorized(req)) {
      sendUnauthorized(res);
      return;
    }

    sendJson(req, res, 200, {
      defaultSourceId: RESOLVED_DEFAULT_SOURCE_ID,
      sources: TELEMETRY_SOURCES.map((source) => ({
        id: source.id,
        label: source.label,
        mode: source.mode,
        isDefault: source.id === RESOLVED_DEFAULT_SOURCE_ID
      }))
    });
    return;
  }

  if (pathname === "/api/telemetry") {
    if (!isAuthorized(req)) {
      sendUnauthorized(res);
      return;
    }

    const requestedSourceId = String(requestUrl.searchParams.get("source") || RESOLVED_DEFAULT_SOURCE_ID).trim();
    const source = SOURCE_BY_ID.get(requestedSourceId);
    if (!source) {
      sendJson(req, res, 404, {
        ok: false,
        error: `Unknown source '${requestedSourceId}'`,
        availableSources: TELEMETRY_SOURCES.map((item) => item.id)
      });
      return;
    }

    try {
      const telemetry = await buildTelemetryForSource(source);
      sendJson(req, res, 200, telemetry);
    } catch (error) {
      const safeMessage = sanitizeErrorForClient(formatError(error));
      sendJson(req, res, 500, {
        ok: false,
        sourceId: source.id,
        error: safeMessage,
        time: Date.now()
      });
    }
    return;
  }

  serveStatic(req, res);
});

async function main() {
  if (process.argv.includes("--snapshot")) {
    const sourceArg = process.argv.find((arg) => arg.startsWith("--source="));
    const requestedSourceId = sourceArg
      ? sourceArg.slice("--source=".length).trim()
      : RESOLVED_DEFAULT_SOURCE_ID;
    const source = SOURCE_BY_ID.get(requestedSourceId);
    if (!source) {
      process.stderr.write(
        `Unknown source '${requestedSourceId}'. Available: ${TELEMETRY_SOURCES.map((item) => item.id).join(", ")}\n`
      );
      process.exit(1);
      return;
    }

    try {
      const telemetry = await buildTelemetryForSource(source);
      process.stdout.write(`${JSON.stringify(telemetry, null, 2)}\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${formatError(error)}\n`);
      process.exit(1);
    }
    return;
  }

  server.timeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS + 5000;
  server.keepAliveTimeout = 65000;

  server.on("error", (error) => {
    process.stderr.write(`Server failed to start: ${formatError(error)}\n`);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const sourceSummary = TELEMETRY_SOURCES
      .map((source) => `${source.id}:${source.mode}`)
      .join(", ");
    process.stdout.write(
      `OpenClaw Agents Control Center is live at http://${HOST}:${PORT}\n` +
        `Auth ${DASH_TOKEN ? "ENABLED" : "DISABLED"} · Default Source ${RESOLVED_DEFAULT_SOURCE_ID} · Sources ${sourceSummary}\n`
    );
  });
}

main();
