importScripts("lib/tickpilot-options.js");

const DEFAULT_OPTIONS = { ...TICKPILOT_DEFAULTS };

const DEFAULT_RUNTIME = {
  running: false,
  completed: false,
  connected: false,
  platform: "idle",
  pageTitle: "Open the test arena to begin.",
  message: "Test build ready. Mirror runs full flow; live sites are detect-only.",
  completedSteps: 0,
  steps: { queue: "WAITING", selection: "WAITING", form: "WAITING", complete: "WAITING" },
  logs: [],
  botActive: false,
};

function withDefaults(stored) {
  return {
    options: { ...DEFAULT_OPTIONS, ...(stored.options || {}) },
    runtime: { ...DEFAULT_RUNTIME, ...(stored.runtime || {}), logs: stored.runtime?.logs || [] },
    command: stored.command || null,
  };
}

async function readState() {
  const stored = await chrome.storage.local.get(["tickpilot"]);
  return withDefaults(stored.tickpilot || {});
}

async function writeState(next) {
  await chrome.storage.local.set({ tickpilot: next });
  return next;
}

async function setBadge(runtime) {
  if (runtime.running) {
    await chrome.action.setBadgeBackgroundColor({ color: "#14b8a6" });
    await chrome.action.setBadgeText({ text: "BOT" });
    return;
  }
  if (runtime.completed) {
    await chrome.action.setBadgeBackgroundColor({ color: "#f0c14b" });
    await chrome.action.setBadgeText({ text: "OK" });
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
}

function arenaUrl(options) {
  const base = chrome.runtime.getURL("demo/index.html");
  const platform = options?.platform === "kktix" ? "kktix" : "hkt";
  return `${base}?platform=${platform}`;
}

async function findArenaTab(options) {
  const prefix = chrome.runtime.getURL("demo/index.html");
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.url && tab.url.startsWith(prefix)) || null;
}

const LIVE_HOSTS = [
  "hkticketing.com", "hkt.hkticketing.com", "busy.hkticketing.com",
  "kktix.com", "kktix.cc", "cityline.com", "urbtix.hk",
];

function isLiveTab(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return LIVE_HOSTS.some(h => host.endsWith(h));
  } catch { return false; }
}

async function findLiveTab(options) {
  const tabs = await chrome.tabs.query({});
  return tabs.find(tab => isLiveTab(tab.url)) || null;
}

async function openArena(options) {
  const url = arenaUrl(options);
  const existing = await findArenaTab(options);
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true, url });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  return chrome.tabs.create({ url });
}

async function notify(title, message) {
  try {
    await chrome.notifications.create(`tickpilot-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  } catch (_error) {}
}

const recentAlerts = new Map();
const ALERT_DEDUPE_MS = 25_000;

function shouldDedupeAlert(key) {
  const now = Date.now();
  const last = recentAlerts.get(key) || 0;
  if (now - last < ALERT_DEDUPE_MS) return true;
  recentAlerts.set(key, now);
  return false;
}

async function appendLiveLog(state, line) {
  const logs = [line, ...(state.runtime.logs || [])].slice(0, 24);
  return { ...state.runtime, logs, message: line };
}

async function setLiveAssistBadge(stage) {
  const labels = { select: "!", pay: "!", busy: "Q", captcha: "!" };
  const text = labels[stage] || "A";
  await chrome.action.setBadgeBackgroundColor({ color: "#1677ff" });
  await chrome.action.setBadgeText({ text });
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await readState();
  await writeState({
    ...state,
    runtime: { ...DEFAULT_RUNTIME, logs: ["TickPilot installed. Configure settings, then open the mirror arena."] },
  });
  await chrome.action.setBadgeText({ text: "" });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    if (!message?.type) return { ok: false, error: "Unknown message." };

    if (message.type === "TICKPILOT_GET") {
      return { ok: true, state: await readState() };
    }

    if (message.type === "TICKPILOT_SAVE_OPTIONS") {
      const state = await readState();
      return { ok: true, state: await writeState({ ...state, options: { ...state.options, ...message.options } }) };
    }

    if (message.type === "TICKPILOT_OPEN_ARENA") {
      const state = await readState();
      const opts = { ...state.options, ...(message.options || {}) };
      const tab = await openArena(opts);
      return { ok: true, tabId: tab.id };
    }

    if (message.type === "TICKPILOT_START") {
      const state = await readState();
      const mode = message.mode || "function2";
      const options = {
        ...state.options,
        ...(message.options || {}),
        function1Enabled: mode === "function1",
        function2Enabled: mode === "function2",
      };
      const next = await writeState({
        ...state,
        options,
        command: { type: "start", at: Date.now(), mode },
        runtime: { ...state.runtime, botActive: true, running: true },
      });
      await openArena(options);
      return { ok: true, state: next };
    }

    if (message.type === "TICKPILOT_START_LIVE") {
      const state = await readState();
      const mode = message.mode || "function2";
      const options = {
        ...state.options,
        ...(message.options || {}),
        function1Enabled: mode === "function1",
        function2Enabled: mode === "function2",
      };
      const next = await writeState({
        ...state,
        options,
        command: { type: "start", at: Date.now(), mode },
        runtime: { ...state.runtime, botActive: true, running: true, platform: "HKTicketing" },
      });
      // Route to existing live tab or open new one
      let liveTab = await findLiveTab(options);
      if (!liveTab) {
        const url = options.platform === "kktix"
          ? "https://kktix.com/events"
          : "https://www.hkticketing.com.hk";
        const [tab] = await chrome.tabs.create({ url, active: true });
        liveTab = tab;
        await new Promise(r => setTimeout(r, 1500)); // wait for content script
      } else {
        await chrome.tabs.update(liveTab.id, { active: true });
      }
      if (liveTab?.id) {
        chrome.tabs.sendMessage(liveTab.id, { type: "LIVE_AUTO_START", options }).catch(() => {});
      }
      await setBadge(next.runtime);
      return { ok: true, state: next };
    }

    if (message.type === "TICKPILOT_STOP") {
      const state = await readState();
      // Stop live auto in all live tabs
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id && isLiveTab(tab.url)) {
          chrome.tabs.sendMessage(tab.id, { type: "LIVE_AUTO_STOP" }).catch(() => {});
        }
      }
      return {
        ok: true,
        state: await writeState({
          ...state,
          command: { type: "stop", at: Date.now() },
          runtime: { ...state.runtime, botActive: false, running: false },
        }),
      };
    }

    if (message.type === "TICKPILOT_RUNTIME") {
      const state = await readState();
      if (state.runtime.running && message.runtime?.platform && message.runtime.platform !== "arena") {
        return { ok: true, state, ignored: true };
      }
      const runtime = {
        ...state.runtime,
        ...message.runtime,
        botActive: message.runtime?.running ?? state.runtime.botActive,
        logs: message.runtime?.logs || state.runtime.logs,
      };
      const next = await writeState({ ...state, runtime, command: null });
      await setBadge(runtime);
      if (message.notify) await notify(message.notify.title, message.notify.message);
      return { ok: true, state: next };
    }

    if (message.type === "TICKPILOT_CLEAR_LOG") {
      const state = await readState();
      return { ok: true, state: await writeState({ ...state, runtime: { ...state.runtime, logs: [] } }) };
    }

    if (message.type === "TICKPILOT_LIVE_ALERT") {
      const state = await readState();
      const alert = message.alert || {};
      const options = { ...state.options, ...(message.options || {}) };
      if (options.liveAssistEnabled === false) return { ok: true, state, ignored: true };
      if (shouldDedupeAlert(alert.key || `${alert.type}:${alert.message}`)) {
        return { ok: true, state, deduped: true };
      }

      const stamp = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      const line = `[${stamp}] ${alert.message}`;
      const runtime = await appendLiveLog(state, line);
      runtime.botActive = false;
      runtime.platform = "HKTicketing";
      runtime.connected = true;

      const next = await writeState({ ...state, options, runtime });
      await setLiveAssistBadge(alert.type === "captcha" ? "captcha" : alert.stage || "select");

      if (options.alertDesktop !== false && (alert.priority === "critical" || alert.priority === "warn")) {
        await notify("TickPilot Assist", alert.message);
      }
      return { ok: true, state: next };
    }

    if (message.type === "TICKPILOT_LIVE_LOG") {
      const state = await readState();
      const entry = message.entry || {};
      const line = `[${entry.at}] ${entry.text}`;
      const runtime = await appendLiveLog(state, line);
      runtime.platform = "HKTicketing";
      runtime.connected = true;
      const next = await writeState({ ...state, runtime });
      return { ok: true, state: next };
    }

    return { ok: false, error: "Unhandled message." };
  };

  handle().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
