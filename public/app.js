const AUTO_REFRESH_MS = 12000;
const SIM_TICK_MS = 850;
const MAX_OFFICE_EVENTS = 18;
const MISSION_WINDOW_MS = 60 * 60 * 1000;
const MAX_TIMELINE_ITEMS = 8;
const MAX_ALERT_ITEMS = 6;
const AUTH_STORAGE_KEY = "openclaw_dashboard_token";

const OFFICE_ZONES = {
  command: { x: 18, y: 21 },
  research: { x: 52, y: 20 },
  server: { x: 84, y: 24 },
  strategy: { x: 30, y: 72 },
  lounge: { x: 76, y: 72 },
  offline: { x: 94, y: 92 }
};

const elements = {
  refreshBtn: document.querySelector("#refreshBtn"),
  lastUpdated: document.querySelector("#lastUpdated"),
  statusLine: document.querySelector("#statusLine"),
  metricGrid: document.querySelector("#metricGrid"),
  agentGrid: document.querySelector("#agentGrid"),
  activityList: document.querySelector("#activityList"),
  cronTable: document.querySelector("#cronTable"),
  simToggle: document.querySelector("#simToggle"),
  cruiseToggle: document.querySelector("#cruiseToggle"),
  cameraResetBtn: document.querySelector("#cameraResetBtn"),
  officeViewport: document.querySelector("#officeViewport"),
  office3dStatus: document.querySelector("#office3dStatus"),
  officeFeed: document.querySelector("#officeFeed"),
  localClock: document.querySelector("#localClock"),
  engineMode: document.querySelector("#engineMode"),
  agentHeat: document.querySelector("#agentHeat"),
  alertCount: document.querySelector("#alertCount"),
  sourcePicker: document.querySelector("#sourcePicker"),
  missionTimeline: document.querySelector("#missionTimeline"),
  collabNetwork: document.querySelector("#collabNetwork"),
  alertConsole: document.querySelector("#alertConsole"),
  tokenHeat: document.querySelector("#tokenHeat"),
  actionForceRefresh: document.querySelector("#actionForceRefresh"),
  actionFocusHotAgent: document.querySelector("#actionFocusHotAgent"),
  actionToggleCruise: document.querySelector("#actionToggleCruise"),
  actionToggleMotion: document.querySelector("#actionToggleMotion"),
  actionSnapshot: document.querySelector("#actionSnapshot"),
  actionDeckStatus: document.querySelector("#actionDeckStatus"),
  stageRadar: document.querySelector("#stageRadar"),
  stageTaskMatrix: document.querySelector("#stageTaskMatrix"),
  stagePulse: document.querySelector("#stagePulse"),
  stageLineCanvas: document.querySelector("#stageLineCanvas"),
  stageWaveCanvas: document.querySelector("#stageWaveCanvas")
};

const simulation = {
  enabled: true,
  agents: new Map(),
  events: [],
  lastTickAt: Date.now(),
  lastActivitySignature: null
};

const officeView = {
  engine: null,
  ready: false,
  failed: false
};

let isFetching = false;
let refreshTimerId = null;
let simTimerId = null;
let latestTelemetry = null;
let focusedAgentId = null;
let actionDeckFeedback = "等待实时数据...";
let actionDeckFeedbackLevel = "info";
let stageAnimationId = null;
let authToken = "";
let sourceList = [];
let currentSourceId = null;
let authPromptLockedUntil = 0;

const stageFx = {
  lineSamples: Array.from({ length: 56 }, () => 48),
  metrics: {
    live: 50,
    run: 40,
    latency: 50,
    health: 70
  },
  phase: 0,
  lastSampleAt: 0
};

authToken = readStoredToken();

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toLocaleString("zh-CN");
}

function formatRelative(ms) {
  if (typeof ms !== "number" || ms < 0) {
    return "未知";
  }
  if (ms < 60_000) {
    return `${Math.max(1, Math.floor(ms / 1000))} 秒前`;
  }
  if (ms < 3_600_000) {
    return `${Math.floor(ms / 60_000)} 分钟前`;
  }
  if (ms < 86_400_000) {
    return `${Math.floor(ms / 3_600_000)} 小时前`;
  }
  return `${Math.floor(ms / 86_400_000)} 天前`;
}

function formatDateTime(ts) {
  if (!ts) {
    return "-";
  }
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function formatClock(ts) {
  if (!ts) {
    return "--:--";
  }
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatEta(ms) {
  if (typeof ms !== "number") {
    return "待定";
  }
  if (ms <= 0) {
    return "进行中";
  }
  if (ms < 60_000) {
    return "<1 分钟";
  }
  return `${Math.ceil(ms / 60_000)} 分钟后`;
}

function readStoredToken() {
  try {
    const sessionToken = String(globalThis.sessionStorage?.getItem(AUTH_STORAGE_KEY) || "").trim();
    if (sessionToken) {
      return sessionToken;
    }

    // Migrate legacy localStorage token to session-only storage.
    const legacyToken = String(globalThis.localStorage?.getItem(AUTH_STORAGE_KEY) || "").trim();
    if (legacyToken) {
      globalThis.sessionStorage?.setItem(AUTH_STORAGE_KEY, legacyToken);
      globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
      return legacyToken;
    }
    return "";
  } catch {
    return "";
  }
}

function storeToken(token) {
  try {
    if (!token) {
      globalThis.sessionStorage?.removeItem(AUTH_STORAGE_KEY);
      globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
      return;
    }
    globalThis.sessionStorage?.setItem(AUTH_STORAGE_KEY, token);
    globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

function apiUrl(pathname, params = {}) {
  const url = new URL(pathname, globalThis.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

async function fetchApi(pathname, { params = {}, allowPrompt = true } = {}) {
  const requestUrl = apiUrl(pathname, params);
  let prompted = false;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const headers = {};
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const response = await fetch(requestUrl, {
      cache: "no-store",
      headers
    });

    if (response.status !== 401) {
      return response;
    }

    if (!allowPrompt || prompted || Date.now() < authPromptLockedUntil) {
      return response;
    }

    prompted = true;
    const userInput = window.prompt("请输入 Dashboard Token（仅当前浏览器会话保存）", authToken || "");
    const nextToken = String(userInput || "").trim();
    if (!nextToken) {
      authPromptLockedUntil = Date.now() + 30_000;
      return response;
    }
    authToken = nextToken;
    storeToken(authToken);
  }

  throw new Error("认证重试次数已耗尽");
}

function renderSourcePicker() {
  if (!elements.sourcePicker) {
    return;
  }

  if (!sourceList.length) {
    elements.sourcePicker.innerHTML = '<option value="local">local</option>';
    elements.sourcePicker.disabled = true;
    return;
  }

  elements.sourcePicker.innerHTML = sourceList
    .map(
      (source) => `
      <option value="${escapeHtml(source.id)}">
        ${escapeHtml(source.label)} (${escapeHtml(source.mode)})
      </option>
    `
    )
    .join("");

  const fallback = sourceList[0]?.id || "local";
  currentSourceId = currentSourceId || fallback;
  if (!sourceList.some((item) => item.id === currentSourceId)) {
    currentSourceId = fallback;
  }
  elements.sourcePicker.value = currentSourceId;
  elements.sourcePicker.disabled = sourceList.length <= 1;
}

async function loadSources() {
  const response = await fetchApi("/api/sources", { allowPrompt: true });
  if (!response.ok) {
    throw new Error(`加载监控源失败 HTTP ${response.status}`);
  }

  const payload = await response.json();
  const list = Array.isArray(payload.sources) ? payload.sources : [];
  sourceList = list;
  currentSourceId = payload.defaultSourceId || list[0]?.id || "local";
  renderSourcePicker();
}

function hashCode(source) {
  const text = String(source || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function stableRangeFromText(source, min, max) {
  if (max <= min) {
    return min;
  }
  return min + (hashCode(source) % (max - min + 1));
}

function stateRank(state) {
  switch (state) {
    case "RUNNING":
      return 4;
    case "ACTIVE":
      return 3;
    case "IDLE":
      return 2;
    default:
      return 1;
  }
}

function computeAgentPressure(agent) {
  const usage = agent?.latestSession?.percentUsed;
  if (typeof usage === "number") {
    return clamp(usage, 0, 100);
  }
  if (agent?.liveState === "RUNNING") {
    return 83;
  }
  if (agent?.liveState === "ACTIVE") {
    return 61;
  }
  if (agent?.liveState === "IDLE") {
    return 34;
  }
  return 12;
}

function hotAgentScore(agent) {
  const pressure = computeAgentPressure(agent);
  const tokenFactor = Math.log10((agent?.latestSession?.totalTokens || 0) + 10);
  return stateRank(agent?.liveState) * 20 + pressure + tokenFactor * 8;
}

function pickHotAgent(agents) {
  if (!Array.isArray(agents) || !agents.length) {
    return null;
  }
  return [...agents].sort((a, b) => hotAgentScore(b) - hotAgentScore(a))[0] || null;
}

function shortAgentTag(agentId) {
  const raw = String(agentId || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) {
    return "AG";
  }
  return raw.slice(0, 2);
}

function liveStateLabel(state) {
  switch (state) {
    case "RUNNING":
      return "RUNNING";
    case "ACTIVE":
      return "ACTIVE";
    case "IDLE":
      return "IDLE";
    default:
      return "OFFLINE";
  }
}

function liveStateClass(state) {
  switch (state) {
    case "RUNNING":
      return "state-running";
    case "ACTIVE":
      return "state-active";
    case "IDLE":
      return "state-idle";
    default:
      return "state-offline";
  }
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resizeCanvas(canvas) {
  if (!canvas) {
    return { ctx: null, width: 0, height: 0 };
  }
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const cssWidth = Math.max(1, Math.floor(canvas.clientWidth));
  const cssHeight = Math.max(1, Math.floor(canvas.clientHeight));
  const width = Math.max(1, Math.floor(cssWidth * dpr));
  const height = Math.max(1, Math.floor(cssHeight * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { ctx: null, width: 0, height: 0 };
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: cssWidth, height: cssHeight };
}

function computeStageMetrics(data, alertItems = []) {
  const summary = data?.summary || {};
  const latency = data?.meta?.commandLatencyMs || {};
  const total = Math.max(1, summary.totalAgents || 1);
  const live = Math.round(((summary.activeAgents || 0) / total) * 100);
  const run = Math.round(((summary.runningAgents || 0) / total) * 100);
  const latencyScore = latency.status
    ? clamp(100 - Math.round(latency.status / 4.6), 8, 100)
    : 52;
  const alertPenalty = (alertItems || []).filter((item) => item.level !== "ok").length * 21;
  const health = clamp(100 - alertPenalty, 6, 100);
  return {
    live,
    run,
    latency: latencyScore,
    health
  };
}

function shortTaskLabel(text) {
  const source = String(text || "");
  if (!source) {
    return "待命";
  }
  return source.length <= 18 ? source : `${source.slice(0, 18)}...`;
}

function inferZone(agent) {
  const work = String(agent.currentWork || "");
  if (agent.liveState === "OFFLINE") {
    return "offline";
  }
  if (work.includes("Cron") || work.includes("定时")) {
    return "server";
  }
  if (work.includes("Telegram") || work.includes("Topic") || work.includes("消息")) {
    return "command";
  }
  if (work.includes("主会话")) {
    return "strategy";
  }
  if (agent.liveState === "IDLE") {
    return "lounge";
  }
  return "research";
}

function zonePosition(zoneName) {
  return OFFICE_ZONES[zoneName] || OFFICE_ZONES.research;
}

function computeEnergy(agent) {
  const usage = agent.latestSession?.percentUsed;
  if (typeof usage === "number") {
    return clamp(usage / 100, 0.12, 0.98);
  }
  if (agent.liveState === "RUNNING") {
    return 0.85;
  }
  if (agent.liveState === "ACTIVE") {
    return 0.65;
  }
  if (agent.liveState === "IDLE") {
    return 0.38;
  }
  return 0.2;
}

function setOfficeStatus(text, isError = false) {
  elements.office3dStatus.textContent = text;
  elements.office3dStatus.style.color = isError ? "var(--red)" : "var(--text-soft)";
  elements.engineMode.textContent = isError
    ? "DEGRADED"
    : elements.cruiseToggle.checked
      ? "CRUISE"
      : "MANUAL";
}

function updateLocalClock() {
  elements.localClock.textContent = new Date().toLocaleTimeString("zh-CN", {
    hour12: false
  });
}

function buildAlertItems({ meta = {}, gateway = {}, agents = [], summary = {} } = {}) {
  const items = [];

  for (const error of meta.errors || []) {
    items.push({
      level: "error",
      title: "命令链路错误",
      detail: error
    });
  }

  for (const warning of meta.warnings || []) {
    items.push({
      level: "warn",
      title: "链路告警",
      detail: warning
    });
  }

  if (gateway?.reachable === false) {
    items.push({
      level: "error",
      title: "Gateway 不可达",
      detail: gateway.url ? `${gateway.url} 响应失败` : "网关状态异常"
    });
  }

  const offlineAgents =
    typeof summary.offlineAgents === "number"
      ? summary.offlineAgents
      : (agents || []).filter((agent) => agent.liveState === "OFFLINE").length;
  if (offlineAgents > 0) {
    items.push({
      level: "warn",
      title: "存在离线 Agent",
      detail: `${offlineAgents} 个 Agent 处于离线状态`
    });
  }

  const runningAgents =
    typeof summary.runningAgents === "number"
      ? summary.runningAgents
      : (agents || []).filter((agent) => agent.liveState === "RUNNING").length;
  const totalAgents =
    typeof summary.totalAgents === "number" ? summary.totalAgents : (agents || []).length;
  if (totalAgents > 0 && runningAgents === 0) {
    items.push({
      level: "warn",
      title: "无执行中 Agent",
      detail: "当前没有 RUNNING Agent，链路吞吐可能降低"
    });
  }

  if (!items.length) {
    items.push({
      level: "ok",
      title: "链路稳定",
      detail: "未检测到异常，数据更新正常"
    });
  }

  return items.slice(0, MAX_ALERT_ITEMS);
}

function renderCommandRibbon(summary, alertItems = []) {
  elements.agentHeat.textContent = `${summary.activeAgents}/${summary.totalAgents}`;
  const alerts = alertItems.filter((item) => item.level !== "ok").length;
  elements.alertCount.textContent = String(alerts);
}

function buildMissionTimelineItems(data) {
  const now = Date.now();
  const items = [];
  const cronJobs = data?.cronJobs || [];
  const agents = data?.agents || [];
  const activity = data?.activity || [];

  for (const job of cronJobs) {
    if (!job.enabled || typeof job.nextRunAtMs !== "number") {
      continue;
    }
    const etaMs = job.nextRunAtMs - now;
    if (etaMs > MISSION_WINDOW_MS || etaMs < -8 * 60_000) {
      continue;
    }
    items.push({
      key: `cron-${job.id}`,
      kind: "cron",
      tone: job.runningNow ? "critical" : "normal",
      title: job.name || "Cron 任务",
      detail: `${job.agentId} · ${job.scheduleExpr}`,
      etaMs
    });
  }

  for (const agent of agents) {
    if (agent.liveState !== "RUNNING" && agent.liveState !== "ACTIVE") {
      continue;
    }
    const baseMinutes = agent.liveState === "RUNNING" ? 5 : 12;
    const jitter = stableRangeFromText(`${agent.id}:${agent.currentWork}`, 2, 22);
    const coolDown = Math.floor((agent.lastActiveAgeMs || 0) / 120_000);
    const etaMinutes = clamp(baseMinutes + jitter - coolDown, 2, 58);
    items.push({
      key: `agent-${agent.id}`,
      kind: "agent",
      tone: agent.liveState === "RUNNING" ? "critical" : "normal",
      title: `${agent.id} · ${shortTaskLabel(agent.currentWork)}`,
      detail: agent.liveState === "RUNNING" ? "执行阶段推进中" : "活跃任务待收敛",
      etaMs: etaMinutes * 60_000
    });
  }

  for (const entry of activity.slice(0, 6)) {
    if (typeof entry.ageMs !== "number" || entry.ageMs > 12 * 60_000) {
      continue;
    }
    const followUpMinutes = stableRangeFromText(`${entry.agentId}:${entry.key}`, 3, 20);
    items.push({
      key: `flow-${entry.agentId}-${entry.key || "none"}`,
      kind: "flow",
      tone: "normal",
      title: `${entry.agentId} · ${shortTaskLabel(entry.action)}`,
      detail: "活动流后续响应窗口",
      etaMs: followUpMinutes * 60_000
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const item of items.sort((a, b) => a.etaMs - b.etaMs)) {
    if (seen.has(item.key)) {
      continue;
    }
    seen.add(item.key);
    deduped.push(item);
  }
  return deduped.slice(0, MAX_TIMELINE_ITEMS);
}

function renderMissionTimeline(data) {
  const items = buildMissionTimelineItems(data);
  if (!items.length) {
    elements.missionTimeline.innerHTML = '<p class="empty">未来 60 分钟暂无明确任务轨道</p>';
    return;
  }

  elements.missionTimeline.innerHTML = items
    .map((item) => {
      const eta = clamp(item.etaMs, 0, MISSION_WINDOW_MS);
      const urgency = clamp(
        Math.round(((MISSION_WINDOW_MS - eta) / MISSION_WINDOW_MS) * 100),
        6,
        100
      );
      const etaClock = formatClock(Date.now() + Math.max(0, item.etaMs));
      return `
        <article class="timeline-item tone-${item.tone}">
          <div class="timeline-head">
            <span class="timeline-kind">${escapeHtml(item.kind.toUpperCase())}</span>
            <span class="timeline-eta">${escapeHtml(formatEta(item.etaMs))} · ${escapeHtml(etaClock)}</span>
          </div>
          <p class="timeline-title">${escapeHtml(item.title)}</p>
          <p class="timeline-detail">${escapeHtml(item.detail)}</p>
          <div class="timeline-track">
            <span style="width:${urgency}%"></span>
          </div>
        </article>
      `;
    })
    .join("");
}

function buildCollabGraph(agents = [], activity = []) {
  const nodes = agents.slice(0, 8).map((agent, index, list) => {
    const count = list.length;
    const angle =
      count <= 1 ? 0 : (-Math.PI / 2) + (index / count) * Math.PI * 2;
    return {
      id: agent.id,
      state: agent.liveState,
      pressure: computeAgentPressure(agent),
      x: count <= 1 ? 50 : 50 + Math.cos(angle) * 38,
      y: count <= 1 ? 50 : 50 + Math.sin(angle) * 32
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = new Map();
  for (let idx = 0; idx < activity.length - 1; idx += 1) {
    const left = activity[idx];
    const right = activity[idx + 1];
    if (!left || !right) {
      continue;
    }
    if (left.agentId === right.agentId) {
      continue;
    }
    if (!nodeIds.has(left.agentId) || !nodeIds.has(right.agentId)) {
      continue;
    }
    if (
      typeof left.updatedAt === "number" &&
      typeof right.updatedAt === "number" &&
      Math.abs(left.updatedAt - right.updatedAt) > 30 * 60_000
    ) {
      continue;
    }

    const key = [left.agentId, right.agentId].sort().join("::");
    links.set(key, (links.get(key) || 0) + 1);
  }

  if (!links.size && nodes.length > 1) {
    const hotNode = [...nodes].sort((a, b) => b.pressure - a.pressure)[0];
    for (const node of nodes) {
      if (node.id === hotNode.id) {
        continue;
      }
      const key = [hotNode.id, node.id].sort().join("::");
      links.set(key, 1);
    }
  }

  return {
    nodes,
    edges: [...links.entries()]
      .map(([key, weight]) => {
        const [from, to] = key.split("::");
        return { from, to, weight };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12)
  };
}

function renderCollabNetwork(agents, activity) {
  const graph = buildCollabGraph(agents, activity);
  if (!graph.nodes.length) {
    elements.collabNetwork.innerHTML = '<p class="empty">暂无 Agent 协同关系数据</p>';
    return;
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const hotAgent = pickHotAgent(agents);
  const edgeMarkup = graph.edges
    .map((edge) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) {
        return "";
      }
      const width = clamp(0.8 + edge.weight * 0.85, 1, 4.8);
      const opacity = clamp(0.25 + edge.weight * 0.16, 0.25, 0.9);
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke-width="${width}" style="opacity:${opacity}"></line>`;
    })
    .join("");

  const nodeMarkup = graph.nodes
    .map((node) => `
      <button
        type="button"
        class="network-node ${liveStateClass(node.state)} ${hotAgent?.id === node.id ? "is-hot" : ""}"
        style="left:${node.x}%;top:${node.y}%"
        data-agent-id="${escapeHtml(node.id)}"
      >
        <span>${escapeHtml(shortAgentTag(node.id))}</span>
        <small>${Math.round(node.pressure)}%</small>
      </button>
    `)
    .join("");

  elements.collabNetwork.innerHTML = `
    <div class="network-stage">
      <svg class="network-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        ${edgeMarkup}
      </svg>
      <div class="network-layer">${nodeMarkup}</div>
    </div>
    <p class="network-foot">节点 ${graph.nodes.length} · 协同链路 ${graph.edges.length}</p>
  `;
}

function renderAlertConsole(alertItems) {
  if (!alertItems.length) {
    elements.alertConsole.innerHTML = '<p class="empty">暂无告警</p>';
    return;
  }

  elements.alertConsole.innerHTML = alertItems
    .map(
      (item) => `
      <article class="alert-item level-${item.level}">
        <div class="alert-head">
          <span class="alert-level">${escapeHtml(item.level.toUpperCase())}</span>
          <span class="alert-time">${escapeHtml(formatClock(Date.now()))}</span>
        </div>
        <p class="alert-title">${escapeHtml(item.title)}</p>
        <p class="alert-detail">${escapeHtml(item.detail)}</p>
      </article>
    `
    )
    .join("");
}

function renderTokenHeat(agents) {
  const list = (agents || [])
    .map((agent) => ({
      id: agent.id,
      state: agent.liveState,
      pressure: computeAgentPressure(agent),
      tokens: agent.latestSession?.totalTokens || 0
    }))
    .sort((a, b) => b.pressure - a.pressure)
    .slice(0, 7);

  if (!list.length) {
    elements.tokenHeat.innerHTML = '<p class="empty">暂无 Token 热度数据</p>';
    return;
  }

  const avgPressure =
    list.reduce((sum, item) => sum + item.pressure, 0) / Math.max(1, list.length);
  const totalTokens = list.reduce((sum, item) => sum + item.tokens, 0);

  const rows = list
    .map((item) => {
      const level =
        item.pressure >= 75 ? "high" : item.pressure >= 45 ? "mid" : "low";
      return `
        <div class="heat-row level-${level}">
          <span class="heat-agent">${escapeHtml(item.id)}</span>
          <div class="heat-bar">
            <span style="width:${clamp(Math.round(item.pressure), 4, 100)}%"></span>
          </div>
          <span class="heat-value">${Math.round(item.pressure)}%</span>
        </div>
      `;
    })
    .join("");

  elements.tokenHeat.innerHTML = `
    <div class="heat-overview">
      <p>平均压力 <strong>${Math.round(avgPressure)}%</strong></p>
      <p>聚合 Token <strong>${escapeHtml(formatNumber(totalTokens))}</strong></p>
    </div>
    <div class="heat-rows">${rows}</div>
  `;
}

function setActionDeckFeedback(text, level = "info") {
  actionDeckFeedback = text;
  actionDeckFeedbackLevel = level;
  renderActionDeck(latestTelemetry);
}

function renderActionDeck(data) {
  const agents = data?.agents || [];
  const summary = data?.summary || {};
  const hotAgent = pickHotAgent(agents);
  const cruiseOn = Boolean(elements.cruiseToggle.checked);
  const motionOn = Boolean(simulation.enabled);

  if (elements.actionToggleCruise) {
    elements.actionToggleCruise.textContent = `巡航 ${cruiseOn ? "ON" : "OFF"}`;
  }
  if (elements.actionToggleMotion) {
    elements.actionToggleMotion.textContent = `动画 ${motionOn ? "ON" : "OFF"}`;
  }
  if (elements.actionFocusHotAgent) {
    elements.actionFocusHotAgent.disabled = !hotAgent;
  }

  const lines = [
    `热点 Agent: ${hotAgent ? hotAgent.id : "暂无"}`,
    `在线 ${summary.activeAgents ?? 0}/${summary.totalAgents ?? 0} · ${cruiseOn ? "巡航" : "手动"} · ${motionOn ? "动画" : "静态"}`,
    actionDeckFeedback
  ];

  const toneClass =
    actionDeckFeedbackLevel === "error"
      ? "status-err"
      : actionDeckFeedbackLevel === "warn"
        ? "status-warn"
        : "status-info";

  if (elements.actionDeckStatus) {
    elements.actionDeckStatus.innerHTML = `
      <p>${escapeHtml(lines[0])}</p>
      <p>${escapeHtml(lines[1])}</p>
      <p class="${toneClass}">${escapeHtml(lines[2])}</p>
    `;
  }
}

function getStageRadarEntries(agents = []) {
  if (simulation.agents.size > 0) {
    return [...simulation.agents.values()].map((agent) => ({
      id: agent.id,
      state: agent.state,
      x: clamp(agent.x, 4, 96),
      y: clamp(agent.y, 6, 94),
      energy: clamp(agent.energy || 0.3, 0.1, 1),
      task: agent.task || "待命"
    }));
  }

  return agents.map((agent) => {
    const zone = zonePosition(inferZone(agent));
    const jitterX = stableRangeFromText(`${agent.id}:x`, -6, 6);
    const jitterY = stableRangeFromText(`${agent.id}:y`, -5, 5);
    return {
      id: agent.id,
      state: agent.liveState,
      x: clamp(zone.x + jitterX, 4, 96),
      y: clamp(zone.y + jitterY, 6, 94),
      energy: computeEnergy(agent),
      task: agent.currentWork || "待命"
    };
  });
}

function renderStageRadar(data) {
  if (!elements.stageRadar) {
    return;
  }

  const agents = getStageRadarEntries(data?.agents || []).slice(0, 14);
  const summary = data?.summary || {};
  if (!agents.length) {
    elements.stageRadar.innerHTML = '<p class="empty">等待雷达目标接入...</p>';
    return;
  }

  const dots = agents
    .map((agent) => {
      const size = 14 + Math.round(agent.energy * 18);
      return `
        <button
          type="button"
          class="radar-dot ${liveStateClass(agent.state)} ${focusedAgentId === agent.id ? "is-focused" : ""}"
          data-agent-id="${escapeHtml(agent.id)}"
          title="${escapeHtml(agent.id)} · ${escapeHtml(shortTaskLabel(agent.task))}"
          style="left:${agent.x}%;top:${agent.y}%;width:${size}px;height:${size}px"
        >
          <span>${escapeHtml(shortAgentTag(agent.id))}</span>
        </button>
      `;
    })
    .join("");

  elements.stageRadar.innerHTML = `
    <div class="stage-radar-board">
      <span class="radar-ring ring-a"></span>
      <span class="radar-ring ring-b"></span>
      <span class="radar-ring ring-c"></span>
      <div class="radar-core">
        <p>LIVE CORE</p>
        <strong>${escapeHtml(`${summary.activeAgents ?? agents.length}/${summary.totalAgents ?? agents.length}`)}</strong>
      </div>
      ${dots}
    </div>
  `;
}

function renderStageTaskMatrix(data) {
  if (!elements.stageTaskMatrix) {
    return;
  }

  const activity = data?.activity || [];
  const agents = data?.agents || [];
  const rows = [];

  for (const item of activity.slice(0, 7)) {
    rows.push({
      id: item.agentId,
      lane: item.kind || "direct",
      text: item.action || "活动更新",
      age: formatRelative(item.ageMs),
      stateClass: "state-active"
    });
  }

  if (!rows.length) {
    for (const agent of agents.slice(0, 7)) {
      rows.push({
        id: agent.id,
        lane: "agent",
        text: agent.currentWork || "待命",
        age: formatRelative(agent.lastActiveAgeMs),
        stateClass: liveStateClass(agent.liveState)
      });
    }
  }

  if (!rows.length) {
    elements.stageTaskMatrix.innerHTML = '<p class="empty">暂无任务火线数据</p>';
    return;
  }

  elements.stageTaskMatrix.innerHTML = rows
    .map(
      (row, index) => `
      <article class="task-lane ${row.stateClass}">
        <div class="task-lane-head">
          <span class="lane-id">#${String(index + 1).padStart(2, "0")} ${escapeHtml(row.id)}</span>
          <span class="lane-age">${escapeHtml(row.age)}</span>
        </div>
        <p class="lane-text">${escapeHtml(shortTaskLabel(row.text))}</p>
        <p class="lane-kind">${escapeHtml(row.lane.toUpperCase())}</p>
      </article>
    `
    )
    .join("");
}

function setStageFxMetrics(data, alertItems = []) {
  const next = computeStageMetrics(data, alertItems);
  stageFx.metrics.live = next.live;
  stageFx.metrics.run = next.run;
  stageFx.metrics.latency = next.latency;
  stageFx.metrics.health = next.health;
}

function drawStageLineCanvas(now) {
  const { ctx, width, height } = resizeCanvas(elements.stageLineCanvas);
  if (!ctx || width <= 0 || height <= 0) {
    return;
  }

  const inset = 8;
  const drawWidth = Math.max(1, width - inset * 2);
  const drawHeight = Math.max(1, height - inset * 2);
  const samples = stageFx.lineSamples;
  const stepX = drawWidth / Math.max(1, samples.length - 1);

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "rgba(9, 24, 45, 0.92)");
  bg.addColorStop(1, "rgba(4, 9, 18, 0.96)");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(93, 228, 255, 0.12)";
  ctx.lineWidth = 1;
  for (let row = 1; row <= 4; row += 1) {
    const y = inset + (drawHeight / 5) * row;
    ctx.beginPath();
    ctx.moveTo(inset, y);
    ctx.lineTo(width - inset, y);
    ctx.stroke();
  }

  ctx.beginPath();
  for (let index = 0; index < samples.length; index += 1) {
    const x = inset + index * stepX;
    const y = inset + drawHeight - (samples[index] / 100) * drawHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.lineTo(width - inset, height - inset);
  ctx.lineTo(inset, height - inset);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, inset, 0, height - inset);
  fill.addColorStop(0, "rgba(93, 228, 255, 0.34)");
  fill.addColorStop(1, "rgba(93, 228, 255, 0.02)");
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  for (let index = 0; index < samples.length; index += 1) {
    const x = inset + index * stepX;
    const y = inset + drawHeight - (samples[index] / 100) * drawHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  const stroke = ctx.createLinearGradient(inset, 0, width - inset, 0);
  stroke.addColorStop(0, "rgba(124, 168, 255, 0.55)");
  stroke.addColorStop(0.58, "rgba(93, 228, 255, 0.96)");
  stroke.addColorStop(1, "rgba(255, 194, 109, 0.9)");
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2.2;
  ctx.shadowColor = "rgba(93, 228, 255, 0.42)";
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  const scanX = inset + (((now * 0.095) % drawWidth + drawWidth) % drawWidth);
  const scan = ctx.createLinearGradient(scanX - 40, 0, scanX + 40, 0);
  scan.addColorStop(0, "rgba(93, 228, 255, 0)");
  scan.addColorStop(0.5, "rgba(93, 228, 255, 0.28)");
  scan.addColorStop(1, "rgba(93, 228, 255, 0)");
  ctx.fillStyle = scan;
  ctx.fillRect(scanX - 40, inset, 80, drawHeight);
}

function drawStageWaveCanvas(now) {
  const { ctx, width, height } = resizeCanvas(elements.stageWaveCanvas);
  if (!ctx || width <= 0 || height <= 0) {
    return;
  }

  const midY = height * 0.5;
  const amplitudeA = 14 + (stageFx.metrics.run / 100) * 22;
  const amplitudeB = 9 + (stageFx.metrics.live / 100) * 18;
  const amplitudeC = 6 + ((100 - stageFx.metrics.health) / 100) * 16;

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "rgba(8, 20, 37, 0.94)");
  bg.addColorStop(1, "rgba(3, 8, 16, 0.96)");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(93, 228, 255, 0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();

  const drawWave = (amplitude, frequency, speed, color, lineWidth, phaseOffset = 0) => {
    ctx.beginPath();
    for (let x = 0; x <= width; x += 2) {
      const angle = x * frequency + now * speed + phaseOffset;
      const modulation = Math.sin(x * frequency * 0.42 + now * speed * 0.55) * amplitude * 0.26;
      const y = midY + Math.sin(angle) * amplitude + modulation;
      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  };

  drawWave(amplitudeA, 0.028, 0.0046, "rgba(93, 228, 255, 0.96)", 2.1);
  drawWave(amplitudeB, 0.036, 0.0061, "rgba(124, 168, 255, 0.78)", 1.6, Math.PI * 0.4);
  drawWave(amplitudeC, 0.044, 0.0082, "rgba(255, 109, 137, 0.52)", 1.2, Math.PI * 0.8);
}

function animateStageFx(now) {
  if (stageAnimationId === null) {
    return;
  }

  const ms = typeof now === "number" ? now : performance.now();
  stageFx.phase = ms * 0.001;
  if (ms - stageFx.lastSampleAt > 165) {
    const m = stageFx.metrics;
    const target = m.live * 0.34 + m.run * 0.29 + m.latency * 0.2 + m.health * 0.17;
    const last = stageFx.lineSamples[stageFx.lineSamples.length - 1] || 50;
    const harmonic = Math.sin(stageFx.phase * 3.2) * 4.8 + Math.cos(stageFx.phase * 1.6) * 2.9;
    const next = clamp(last + (target - last) * 0.31 + harmonic + randomRange(-2.2, 2.2), 8, 96);
    stageFx.lineSamples.shift();
    stageFx.lineSamples.push(next);
    stageFx.lastSampleAt = ms;
  }

  drawStageLineCanvas(ms);
  drawStageWaveCanvas(ms);
  stageAnimationId = requestAnimationFrame(animateStageFx);
}

function ensureStageAnimation() {
  if (stageAnimationId !== null) {
    return;
  }
  stageAnimationId = requestAnimationFrame(animateStageFx);
}

function renderStagePulse(data, alertItems = []) {
  if (!elements.stagePulse) {
    return;
  }

  const stageMetrics = computeStageMetrics(data, alertItems);
  const metrics = [
    {
      label: "LIVE",
      value: stageMetrics.live
    },
    {
      label: "RUN",
      value: stageMetrics.run
    },
    {
      label: "LAT",
      value: stageMetrics.latency
    },
    {
      label: "HEALTH",
      value: stageMetrics.health
    }
  ];

  const chips = metrics
    .map(
      (metric) => `
      <p class="pulse-chip">
        <span>${escapeHtml(metric.label)}</span>
        <strong>${metric.value}%</strong>
      </p>
    `
    )
    .join("");

  const coreLoad = Math.round(
    metrics.reduce((sum, item) => sum + item.value, 0) / Math.max(1, metrics.length)
  );

  elements.stagePulse.innerHTML = `
    <div class="pulse-chips">${chips}</div>
    <p class="pulse-meta">Core Load ${coreLoad}% · 动态波形实时映射链路吞吐与告警压力</p>
  `;
}

function renderTacticalStage(data, alertItems = []) {
  setStageFxMetrics(data, alertItems);
  renderStageRadar(data);
  renderStageTaskMatrix(data);
  renderStagePulse(data, alertItems);
  ensureStageAnimation();
}

function addOfficeEvent(title, meta) {
  simulation.events.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    at: Date.now(),
    title,
    meta
  });
  simulation.events = simulation.events.slice(0, MAX_OFFICE_EVENTS);
  renderOfficeFeed();
}

function renderOfficeFeed() {
  if (!simulation.events.length) {
    elements.officeFeed.innerHTML = '<p class="empty">等待办公室事件流...</p>';
    return;
  }

  elements.officeFeed.innerHTML = simulation.events
    .slice(0, 10)
    .map(
      (event) => `
      <article class="feed-item">
        <p class="feed-title">${escapeHtml(event.title)}</p>
        <p class="feed-meta">${escapeHtml(formatDateTime(event.at))} · ${escapeHtml(event.meta)}</p>
      </article>
    `
    )
    .join("");
}

function getSimAgentsArray() {
  return [...simulation.agents.values()].map((agent) => ({
    id: agent.id,
    state: agent.state,
    x: agent.x,
    y: agent.y,
    energy: agent.energy,
    task: agent.task
  }));
}

function renderOfficeFallback(agents) {
  const entries = agents.length
    ? agents
        .map(
          (agent) => `
      <article class="fallback-item">
        <p class="fallback-title">${escapeHtml(agent.id)} · ${escapeHtml(liveStateLabel(agent.state))}</p>
        <p class="fallback-meta">${escapeHtml(agent.zone)} · ${escapeHtml(shortTaskLabel(agent.task))}</p>
      </article>
    `
        )
        .join("")
    : '<p class="empty">暂无 Agent 空间态数据</p>';

  elements.officeViewport.innerHTML = `<div class="office-fallback">${entries}</div>`;
  elements.officeViewport.classList.add("is-ready");
}

function syncOfficeView() {
  const agents = getSimAgentsArray();
  if (officeView.ready && officeView.engine) {
    officeView.engine.updateAgents(agents);
    return;
  }
  renderOfficeFallback(agents);
}

async function probeAsset(path) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    return {
      path,
      ok: response.ok,
      status: response.status,
      type: response.headers.get("content-type") || "unknown"
    };
  } catch (error) {
    return {
      path,
      ok: false,
      status: "ERR",
      type: String(error?.message || error || "network")
    };
  }
}

function probeSummary(items) {
  return items
    .map((item) => `${item.path}:${item.status}`)
    .join(" ");
}

async function importOfficeModule() {
  const stamp = Date.now();
  try {
    const module = await import(`/office3d.js?v=${stamp}`);
    return {
      module,
      mode: "FULL"
    };
  } catch (primaryError) {
    const probes = await Promise.all([
      probeAsset("/office3d.js"),
      probeAsset("/vendor/three/three.module.js"),
      probeAsset("/vendor/three/three.core.js")
    ]);
    addOfficeEvent("3D 模块探测", probeSummary(probes).slice(0, 120));
    throw new Error(
      `${String(primaryError?.message || primaryError || "import failed")} | probe ${probeSummary(probes)}`
    );
  }
}

async function initOffice3D() {
  setOfficeStatus("3D 引擎加载中...");
  try {
    const loaded = await importOfficeModule();
    const module = loaded.module;
    const fallback = elements.officeViewport.querySelector(".office-fallback");
    if (fallback) {
      fallback.remove();
    }
    officeView.engine = new module.Office3D({ container: elements.officeViewport });
    officeView.ready = true;
    officeView.engine.setMotionEnabled(simulation.enabled);
    officeView.engine.setCruiseMode(Boolean(elements.cruiseToggle.checked));
    elements.officeViewport.classList.add("is-ready");
    setOfficeStatus(
      `3D WebGL ${loaded.mode} ONLINE · ${elements.cruiseToggle.checked ? "CRUISE" : "MANUAL"} · ${simulation.enabled ? "MOTION ON" : "MOTION PAUSED"}`
    );
    addOfficeEvent("3D 办公室已启动", "WebGL 场景与摄像机巡航已接管");
    syncOfficeView();
    renderActionDeck(latestTelemetry);
  } catch (error) {
    officeView.failed = true;
    const reason = String(error?.message || error || "Unknown error");
    setOfficeStatus(`3D 引擎加载失败，已降级 · ${reason.slice(0, 84)}`, true);
    elements.cruiseToggle.disabled = true;
    elements.cameraResetBtn.disabled = true;
    addOfficeEvent("3D 引擎加载失败", reason.slice(0, 120));
    renderOfficeFallback(getSimAgentsArray());
    renderActionDeck(latestTelemetry);
  }
}

function syncSimulation(agents, activity) {
  const incomingIds = new Set((agents || []).map((agent) => agent.id));

  for (const agent of agents || []) {
    const zone = inferZone(agent);
    const center = zonePosition(zone);
    const targetX = clamp(center.x + randomRange(-7, 7), 4, 96);
    const targetY = clamp(center.y + randomRange(-6, 6), 6, 94);
    const energy = computeEnergy(agent);
    const existing = simulation.agents.get(agent.id);

    if (!existing) {
      simulation.agents.set(agent.id, {
        id: agent.id,
        state: agent.liveState,
        zone,
        task: agent.currentWork || "等待新任务",
        x: clamp(targetX + randomRange(-4, 4), 4, 96),
        y: clamp(targetY + randomRange(-4, 4), 6, 94),
        targetX,
        targetY,
        energy,
        sessionsCount: agent.sessionsCount
      });
      addOfficeEvent(
        `Agent ${agent.id} 进入办公室`,
        `${liveStateLabel(agent.liveState)} · ${shortTaskLabel(agent.currentWork)}`
      );
      continue;
    }

    if (existing.state !== agent.liveState) {
      addOfficeEvent(
        `Agent ${agent.id} 状态切换`,
        `${liveStateLabel(existing.state)} -> ${liveStateLabel(agent.liveState)}`
      );
    }
    if (existing.task !== agent.currentWork) {
      addOfficeEvent(`Agent ${agent.id} 切换任务`, shortTaskLabel(agent.currentWork));
    }

    existing.state = agent.liveState;
    existing.zone = zone;
    existing.task = agent.currentWork || "等待新任务";
    existing.targetX = targetX;
    existing.targetY = targetY;
    existing.energy = energy;
    existing.sessionsCount = agent.sessionsCount;
  }

  for (const [agentId] of simulation.agents.entries()) {
    if (!incomingIds.has(agentId)) {
      simulation.agents.delete(agentId);
      addOfficeEvent(`Agent ${agentId} 离开办公室`, "不在当前监控清单");
    }
  }

  const firstActivity = (activity || [])[0];
  if (firstActivity) {
    const signature = `${firstActivity.agentId}:${firstActivity.key || ""}:${firstActivity.updatedAt || ""}`;
    if (signature !== simulation.lastActivitySignature) {
      simulation.lastActivitySignature = signature;
      addOfficeEvent(
        `实时播报: ${firstActivity.agentId}`,
        `${shortTaskLabel(firstActivity.action)} · ${formatRelative(firstActivity.ageMs)}`
      );
    }
  }

  syncOfficeView();
}

function updateSimulationTick() {
  const now = Date.now();
  const dt = Math.max(0.01, (now - simulation.lastTickAt) / 1000);
  simulation.lastTickAt = now;

  for (const agent of simulation.agents.values()) {
    if (simulation.enabled) {
      const speed =
        agent.state === "RUNNING"
          ? 15
          : agent.state === "ACTIVE"
            ? 11
            : agent.state === "IDLE"
              ? 7
              : 4.5;

      const dx = agent.targetX - agent.x;
      const dy = agent.targetY - agent.y;
      const distance = Math.hypot(dx, dy);

      if (distance < 0.8) {
        const center = zonePosition(agent.zone);
        agent.targetX = clamp(center.x + randomRange(-7, 7), 4, 96);
        agent.targetY = clamp(center.y + randomRange(-6, 6), 6, 94);
      } else {
        const step = Math.min(distance, speed * dt);
        agent.x += (dx / distance) * step;
        agent.y += (dy / distance) * step;
      }
    } else {
      agent.x = agent.targetX;
      agent.y = agent.targetY;
    }
  }

  if (officeView.ready && officeView.engine) {
    officeView.engine.updateAgents(getSimAgentsArray());
  }

  if (latestTelemetry) {
    renderStageRadar(latestTelemetry);
  }
}

function renderMetrics(summary, office) {
  const items = [
    {
      label: "Total Agents",
      value: summary.totalAgents,
      hint: `${summary.enabledHeartbeatAgents} 启用心跳`
    },
    {
      label: "Live Agents",
      value: summary.activeAgents,
      hint: `${summary.runningAgents} 正在执行`
    },
    {
      label: "Idle / Offline",
      value: `${summary.idleAgents} / ${summary.offlineAgents}`,
      hint: "待命与离线分布"
    },
    {
      label: "Cron Jobs",
      value: `${summary.enabledCronJobs}/${summary.cronJobs}`,
      hint: `${summary.runningCronJobs} 当前运行`
    },
    {
      label: "Workspace",
      value: `${office.areaSqm}㎡`,
      hint: office.levelHint
    }
  ];

  elements.metricGrid.innerHTML = items
    .map(
      (item) => `
      <section class="metric">
        <p class="label">${escapeHtml(item.label)}</p>
        <p class="value">${escapeHtml(item.value)}</p>
        <p class="hint">${escapeHtml(item.hint)}</p>
      </section>
    `
    )
    .join("");
}

function renderAgents(agents) {
  if (!agents.length) {
    elements.agentGrid.innerHTML = '<p class="empty">暂无 Agent 数据</p>';
    return;
  }

  elements.agentGrid.innerHTML = agents
    .map((agent) => {
      const usage = agent.latestSession?.percentUsed;
      const usageLabel = typeof usage === "number" ? `${usage}%` : "-";
      const usageWidth = typeof usage === "number" ? clamp(usage, 0, 100) : 0;
      const model = agent.latestSession?.model || "unknown";
      const tokens = agent.latestSession?.totalTokens;
      const focusedClass = focusedAgentId === agent.id ? "is-focused" : "";

      return `
        <article class="agent-card ${focusedClass}" data-agent-id="${escapeHtml(agent.id)}">
          <div class="agent-header">
            <h3 class="agent-name">${escapeHtml(agent.id)}</h3>
            <span class="state-chip ${liveStateClass(agent.liveState)}">${liveStateLabel(agent.liveState)}</span>
          </div>
          <p class="agent-work">${escapeHtml(agent.currentWork)}</p>
          <div class="agent-meta">
            <span>最近活跃 ${escapeHtml(formatRelative(agent.lastActiveAgeMs))}</span>
            <span>${escapeHtml(agent.sessionsCount)} 会话</span>
          </div>
          <div class="agent-meta">
            <span>Model: ${escapeHtml(model)}</span>
            <span>Token: ${escapeHtml(formatNumber(tokens))}</span>
          </div>
          <div class="usage-wrap">
            <div class="usage-row">
              <span>Context 占用</span>
              <span>${escapeHtml(usageLabel)}</span>
            </div>
            <div class="usage-bar">
              <span style="width:${usageWidth}%"></span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderActivity(activity) {
  if (!activity.length) {
    elements.activityList.innerHTML = '<p class="empty">暂无活动记录</p>';
    return;
  }

  elements.activityList.innerHTML = activity
    .slice(0, 12)
    .map(
      (item) => `
      <article class="activity-item">
        <div class="activity-top">
          <p class="activity-title">${escapeHtml(item.agentId)} · ${escapeHtml(item.kind)}</p>
          <p class="activity-time">${escapeHtml(formatRelative(item.ageMs))}</p>
        </div>
        <p class="activity-body">${escapeHtml(item.action)}</p>
        <p class="activity-time">
          ${escapeHtml(item.model || "unknown")} · in ${escapeHtml(formatNumber(item.inputTokens))}
          / out ${escapeHtml(formatNumber(item.outputTokens))}
        </p>
      </article>
    `
    )
    .join("");
}

function renderCronTable(cronJobs) {
  if (!cronJobs.length) {
    elements.cronTable.innerHTML = '<p class="empty">暂无 Cron 任务</p>';
    return;
  }

  const rows = cronJobs
    .map((job) => {
      const status = job.runningNow ? "RUNNING" : job.lastRunStatus;
      const statusClass = job.runningNow
        ? "state-running"
        : job.lastRunStatus === "ok"
          ? "state-active"
          : "state-idle";
      return `
        <tr>
          <td>${escapeHtml(job.name)}</td>
          <td>${escapeHtml(job.agentId)}</td>
          <td>${escapeHtml(job.enabled ? "ENABLED" : "DISABLED")}</td>
          <td>${escapeHtml(job.scheduleExpr)}</td>
          <td>${escapeHtml(formatDateTime(job.nextRunAtMs))}</td>
          <td>${escapeHtml(formatRelative(job.lastRunAtMs ? Date.now() - job.lastRunAtMs : null))}</td>
          <td><span class="state-chip ${statusClass}">${escapeHtml(status)}</span></td>
        </tr>
      `;
    })
    .join("");

  elements.cronTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>任务名</th>
          <th>Agent</th>
          <th>启用</th>
          <th>Cron</th>
          <th>下次运行</th>
          <th>上次触发</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function highlightAgentCard(agentId) {
  const cards = elements.agentGrid.querySelectorAll(".agent-card");
  cards.forEach((card) => {
    card.classList.toggle("is-focused", card.getAttribute("data-agent-id") === agentId);
  });
}

function focusAgent(agentId, reason = "战术锁定") {
  if (!agentId) {
    return false;
  }

  focusedAgentId = agentId;
  highlightAgentCard(agentId);

  const card = [...elements.agentGrid.querySelectorAll(".agent-card")].find(
    (node) => node.getAttribute("data-agent-id") === agentId
  );
  if (card) {
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  let focusedIn3D = false;
  if (
    officeView.ready &&
    officeView.engine &&
    typeof officeView.engine.focusAgent === "function"
  ) {
    focusedIn3D = Boolean(officeView.engine.focusAgent(agentId));
    if (focusedIn3D && elements.cruiseToggle.checked) {
      elements.cruiseToggle.checked = false;
      officeView.engine.setCruiseMode(false);
    }
    if (focusedIn3D) {
      setOfficeStatus(
        `3D WebGL ONLINE · MANUAL · ${simulation.enabled ? "MOTION ON" : "MOTION PAUSED"}`
      );
    }
  }

  addOfficeEvent(
    "Agent 焦点锁定",
    `${reason} · ${agentId}${focusedIn3D ? " · 3D聚焦" : " · 列表聚焦"}`
  );
  setActionDeckFeedback(
    `已锁定 ${agentId}${focusedIn3D ? "，3D 视角已跟随" : "，当前处于降级模式"}`,
    "info"
  );
  if (latestTelemetry) {
    renderStageRadar(latestTelemetry);
  }
  return true;
}

function toggleSwitch(input, nextValue) {
  if (!input) {
    return;
  }
  const targetValue = typeof nextValue === "boolean" ? nextValue : !input.checked;
  if (input.checked === targetValue) {
    return;
  }
  input.checked = targetValue;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function buildSnapshotText(data) {
  const nowText = new Date().toLocaleString("zh-CN", { hour12: false });
  const summary = data?.summary || {};
  const agents = data?.agents || [];
  const hot = pickHotAgent(agents);
  const sourceLabel = data?.source?.label || currentSourceId || "local";
  const alerts = buildAlertItems({
    meta: data?.meta || {},
    gateway: data?.gateway || {},
    agents,
    summary
  }).filter((item) => item.level !== "ok");
  const runningCron = (data?.cronJobs || [])
    .filter((job) => job.runningNow)
    .slice(0, 3)
    .map((job) => `${job.name}(${job.agentId})`)
    .join(", ");

  return [
    `[OpenClaw 快照] ${nowText}`,
    `Source: ${sourceLabel}`,
    `Agents: ${summary.activeAgents ?? 0}/${summary.totalAgents ?? 0} online, running ${summary.runningAgents ?? 0}`,
    `Hot Agent: ${hot ? `${hot.id} · ${hot.currentWork}` : "N/A"}`,
    `Alerts: ${alerts.length ? alerts.map((item) => item.title).join(" | ") : "None"}`,
    `Cron Running: ${runningCron || "None"}`,
    `Engine: ${officeView.failed ? "DEGRADED" : elements.cruiseToggle.checked ? "CRUISE" : "MANUAL"} / ${simulation.enabled ? "MOTION ON" : "MOTION PAUSED"}`
  ].join("\n");
}

async function copySnapshot() {
  if (!latestTelemetry) {
    setActionDeckFeedback("暂无可复制的快照数据", "error");
    return;
  }

  const snapshot = buildSnapshotText(latestTelemetry);
  try {
    await navigator.clipboard.writeText(snapshot);
    setActionDeckFeedback("快照已复制到剪贴板", "info");
    addOfficeEvent("Action Deck", "实时快照已复制");
  } catch (error) {
    window.prompt("复制实时快照", snapshot);
    setActionDeckFeedback("剪贴板权限受限，已弹出手动复制窗口", "warn");
    addOfficeEvent("Action Deck", "剪贴板受限，触发手动复制");
  }
}

function setStatusLine(text, isError = false) {
  elements.statusLine.textContent = text;
  elements.statusLine.style.color = isError ? "var(--red)" : "var(--text-soft)";
}

async function fetchTelemetry() {
  if (isFetching) {
    return;
  }
  isFetching = true;
  elements.refreshBtn.disabled = true;

  try {
    const response = await fetchApi("/api/telemetry", {
      params: {
        source: currentSourceId || undefined
      },
      allowPrompt: true
    });
    if (response.status === 401) {
      authToken = "";
      storeToken("");
      authPromptLockedUntil = Date.now() + 30_000;
      throw new Error("认证失败，请重新输入 Dashboard Token");
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    latestTelemetry = data;
    if (data?.source?.id) {
      currentSourceId = data.source.id;
      if (elements.sourcePicker && elements.sourcePicker.value !== currentSourceId) {
        elements.sourcePicker.value = currentSourceId;
      }
    }
    const alertItems = buildAlertItems({
      meta: data.meta || {},
      gateway: data.gateway || {},
      agents: data.agents || [],
      summary: data.summary || {}
    });

    renderMetrics(data.summary, data.office);
    renderCommandRibbon(data.summary, alertItems);
    renderMissionTimeline(data);
    renderCollabNetwork(data.agents || [], data.activity || []);
    renderAlertConsole(alertItems);
    renderTokenHeat(data.agents || []);
    renderActionDeck(data);
    renderAgents(data.agents || []);
    renderActivity(data.activity || []);
    renderCronTable(data.cronJobs || []);
    syncSimulation(data.agents || [], data.activity || []);
    renderTacticalStage(data, alertItems);

    const generatedAt = data.meta?.generatedAt ? formatDateTime(data.meta.generatedAt) : "未知";
    const sourceLabel = data?.source?.label || currentSourceId || "local";
    elements.lastUpdated.textContent = `最近刷新: ${generatedAt} · 源: ${sourceLabel}`;

    if (data.meta?.partial) {
      setStatusLine(
        `部分数据更新成功。错误: ${(data.meta.errors || []).join(" | ") || "未知"}`,
        true
      );
    } else {
      const latency = data.meta?.commandLatencyMs || {};
      setStatusLine(
        `实时链路正常。status ${latency.status ?? "-"}ms · cron ${latency.cron ?? "-"}ms · sessions ${latency.sessions ?? "-"}ms`
      );
    }
  } catch (error) {
    setStatusLine(`刷新失败: ${error.message}`, true);
    setActionDeckFeedback(`刷新失败: ${error.message}`, "error");
  } finally {
    isFetching = false;
    elements.refreshBtn.disabled = false;
  }
}

function setupAutoRefresh() {
  if (refreshTimerId) {
    clearInterval(refreshTimerId);
  }
  refreshTimerId = setInterval(() => {
    fetchTelemetry().catch(() => {});
  }, AUTO_REFRESH_MS);
}

function setupSimulationLoop() {
  if (simTimerId) {
    clearInterval(simTimerId);
  }
  simTimerId = setInterval(() => {
    updateSimulationTick();
  }, SIM_TICK_MS);
}

elements.refreshBtn.addEventListener("click", () => {
  fetchTelemetry().catch(() => {});
});

elements.sourcePicker?.addEventListener("change", (event) => {
  currentSourceId = String(event.target.value || "").trim() || currentSourceId;
  setActionDeckFeedback(`切换监控源: ${currentSourceId}`, "info");
  fetchTelemetry().catch(() => {});
});

elements.simToggle.addEventListener("change", (event) => {
  simulation.enabled = Boolean(event.target.checked);
  if (officeView.ready && officeView.engine) {
    officeView.engine.setMotionEnabled(simulation.enabled);
  }
  addOfficeEvent(
    "模拟层设置变更",
    simulation.enabled ? "动画模式已启用" : "动画模式已暂停"
  );
  if (officeView.ready) {
    setOfficeStatus(
      `3D WebGL ONLINE · ${elements.cruiseToggle.checked ? "CRUISE" : "MANUAL"} · ${simulation.enabled ? "MOTION ON" : "MOTION PAUSED"}`
    );
  }
  renderActionDeck(latestTelemetry);
});

elements.cruiseToggle.addEventListener("change", (event) => {
  if (officeView.ready && officeView.engine) {
    officeView.engine.setCruiseMode(Boolean(event.target.checked));
    addOfficeEvent(
      "摄像机模式切换",
      event.target.checked ? "CRUISE 自动巡航" : "MANUAL 手动观察"
    );
    setOfficeStatus(
      `3D WebGL ONLINE · ${event.target.checked ? "CRUISE" : "MANUAL"} · ${simulation.enabled ? "MOTION ON" : "MOTION PAUSED"}`
    );
  }
  renderActionDeck(latestTelemetry);
});

elements.cameraResetBtn.addEventListener("click", () => {
  if (officeView.ready && officeView.engine) {
    officeView.engine.resetCamera();
    addOfficeEvent("摄像机动作", "视角已重置");
  }
});

elements.actionForceRefresh?.addEventListener("click", () => {
  setActionDeckFeedback("触发强制刷新...", "info");
  fetchTelemetry().catch(() => {});
});

elements.actionFocusHotAgent?.addEventListener("click", () => {
  const hot = pickHotAgent(latestTelemetry?.agents || []);
  if (!hot) {
    setActionDeckFeedback("当前没有可锁定的 Agent", "warn");
    return;
  }
  focusAgent(hot.id, "Action Deck");
});

elements.actionToggleCruise?.addEventListener("click", () => {
  if (elements.cruiseToggle.disabled) {
    setActionDeckFeedback("3D 引擎降级中，巡航不可切换", "warn");
    return;
  }
  toggleSwitch(elements.cruiseToggle);
});

elements.actionToggleMotion?.addEventListener("click", () => {
  toggleSwitch(elements.simToggle);
});

elements.actionSnapshot?.addEventListener("click", () => {
  copySnapshot().catch(() => {
    setActionDeckFeedback("快照复制失败", "error");
  });
});

elements.collabNetwork?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-agent-id]");
  if (!target) {
    return;
  }
  const agentId = target.getAttribute("data-agent-id");
  focusAgent(agentId, "协同网络图");
});

elements.stageRadar?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-agent-id]");
  if (!target) {
    return;
  }
  const agentId = target.getAttribute("data-agent-id");
  focusAgent(agentId, "战术雷达");
});

renderOfficeFeed();
renderMissionTimeline({});
renderCollabNetwork([], []);
renderAlertConsole([]);
renderTokenHeat([]);
renderTacticalStage({}, []);
renderActionDeck(null);
updateLocalClock();
setInterval(updateLocalClock, 1000);
initOffice3D().catch(() => {});
renderSourcePicker();
async function bootstrapDashboard() {
  try {
    await loadSources();
  } catch (error) {
    setStatusLine(`监控源加载失败: ${error.message}`, true);
    addOfficeEvent("监控源加载失败", error.message);
  }
  fetchTelemetry().catch(() => {});
}
bootstrapDashboard().catch(() => {});
setupAutoRefresh();
setupSimulationLoop();
