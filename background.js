importScripts("lib/tickpilot-options.js");



const DEFAULT_OPTIONS = { ...TICKPILOT_DEFAULTS };



const DEFAULT_RUNTIME = {

  running: false,

  connected: false,

  platform: "idle",

  pageTitle: "Open hkt.hkticketing.com and your event page.",

  message: "Log in manually, configure settings, then start the bot.",

  logs: [],

  hkt: null,

  tabRoles: [],

  queueWinner: null,

};



function withDefaults(stored) {

  return {

    options: { ...DEFAULT_OPTIONS, ...(stored.options || {}) },

    runtime: { ...DEFAULT_RUNTIME, ...(stored.runtime || {}), logs: stored.runtime?.logs || [] },

  };

}



/** Append log lines oldest→newest; trim from the front when over limit. */

function appendLogs(existing, newLines, limit) {

  const merged = [...(existing || []), ...(newLines || []).filter(Boolean)];

  if (merged.length <= limit) return merged;

  return merged.slice(-limit);

}



async function readState() {

  const stored = await chrome.storage.local.get(["tickpilot"]);

  return withDefaults(stored.tickpilot || {});

}



async function writeState(next) {

  await chrome.storage.local.set({ tickpilot: next });

  return next;

}



async function setBadge(running) {

  if (running) {

    await chrome.action.setBadgeBackgroundColor({ color: "#14b8a6" });

    await chrome.action.setBadgeText({ text: "BOT" });

    return;

  }

  await chrome.action.setBadgeText({ text: "" });

}



const LIVE_HOSTS = [

  "hkticketing.com", "hkt.hkticketing.com", "busy.hkticketing.com",

  "hkticketing.com.hk",

  "kktix.com", "kktix.cc",

];



function isLiveTab(url) {

  if (!url) return false;

  try {

    const host = new URL(url).hostname.replace(/^www\./, "");

    return LIVE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

  } catch {

    return false;

  }

}



async function findLiveTab() {

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (active?.url && isLiveTab(active.url)) return active;

  const tabs = await chrome.tabs.query({});

  return tabs.find((tab) => isLiveTab(tab.url)) || null;

}



async function sendStartToTab(tabId, options, tabRole) {

  for (let attempt = 0; attempt < 8; attempt += 1) {

    try {

      await chrome.tabs.sendMessage(tabId, {

        type: "LIVE_AUTO_START",

        options: { ...options, tabRole },

      });

      return true;

    } catch (_err) {

      await new Promise((r) => setTimeout(r, 400));

    }

  }

  return false;

}



async function showStageNotification(title, message) {

  try {

    await chrome.notifications.create(`tp-${Date.now()}`, {

      type: "basic",

      iconUrl: "icons/icon128.png",

      title: title || "TickPilot",

      message: message || "Stage changed",

      priority: 2,

    });

  } catch (_e) {}

}



async function startLiveBot(options) {

  let primaryTab = await findLiveTab();

  const defaultUrl = options.platform === "kktix"

    ? "https://kktix.com/events"

    : "https://hkt.hkticketing.com/en/#/home";



  if (!primaryTab) {

    primaryTab = await chrome.tabs.create({ url: defaultUrl, active: true });

    await new Promise((r) => setTimeout(r, 1200));

  } else {

    await chrome.tabs.update(primaryTab.id, { active: true });

  }



  const eventUrl = primaryTab?.url && /allEvents|selectTicket/i.test(primaryTab.url)

    ? primaryTab.url

    : primaryTab?.url || defaultUrl;



  const tabRoles = [{ id: primaryTab.id, role: "primary" }];



  if (options.dualTab !== false && options.platform !== "kktix" && eventUrl.includes("hkticketing")) {

    const backup = await chrome.tabs.create({ url: eventUrl, active: false });

    tabRoles.push({ id: backup.id, role: "backup" });

  }



  const state = await readState();

  await writeState({

    ...state,

    runtime: {

      ...state.runtime,

      tabRoles,

      queueWinner: null,

      message: tabRoles.length > 1

        ? "Dual-tab queue routing started (primary + backup)."

        : state.runtime.message,

    },

  });



  for (const { id, role } of tabRoles) {

    if (id) await sendStartToTab(id, options, role);

  }

}



async function yieldOtherTabs(winnerTabId, reason) {

  const state = await readState();

  const roles = state.runtime.tabRoles || [];

  for (const tab of roles) {

    if (tab.id && tab.id !== winnerTabId) {

      chrome.tabs.sendMessage(tab.id, {

        type: "LIVE_AUTO_YIELD",

        reason: reason || "other tab advanced",

      }).catch(() => {});

    }

  }

}



chrome.runtime.onInstalled.addListener(async () => {

  const state = await readState();

  await writeState({

    ...state,

    runtime: {

      ...DEFAULT_RUNTIME,

      logs: ["TickPilot v2.4 ready. Stock radar + post-queue accelerator. Log in, open event page, start bot ~11:25 HKT."],

    },

  });

  await chrome.action.setBadgeText({ text: "" });

});



chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  const handle = async () => {

    if (!message?.type) return { ok: false, error: "Unknown message." };



    if (message.type === "TICKPILOT_GET") {

      return { ok: true, state: await readState() };

    }



    if (message.type === "TICKPILOT_SAVE_OPTIONS") {

      const state = await readState();

      return { ok: true, state: await writeState({ ...state, options: { ...state.options, ...message.options } }) };

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

        runtime: {

          ...state.runtime,

          running: true,

          platform: options.platform === "kktix" ? "KKTIX" : "HKTicketing",

          message: mode === "function1" ? "Function 1 started." : "Function 2 started.",

          queueWinner: null,

        },

      });

      await startLiveBot(options);

      await setBadge(true);

      return { ok: true, state: next };

    }



    if (message.type === "TICKPILOT_STOP") {

      const state = await readState();

      const tabs = await chrome.tabs.query({});

      for (const tab of tabs) {

        if (tab.id && isLiveTab(tab.url)) {

          chrome.tabs.sendMessage(tab.id, { type: "LIVE_AUTO_STOP" }).catch(() => {});

        }

      }

      const next = await writeState({

        ...state,

        runtime: {

          ...state.runtime,

          running: false,

          message: "Bot stopped.",

          tabRoles: [],

          queueWinner: null,

        },

      });

      await setBadge(false);

      return { ok: true, state: next };

    }



    if (message.type === "TICKPILOT_TEST_ALERT") {

      await showStageNotification("TickPilot test", "Alert + sound work. Ready for sale day.");

      return { ok: true };

    }



    if (message.type === "TICKPILOT_STAGE_ALERT") {

      const state = await readState();

      if (message.stage === "select" && state.options?.notifyOnSelect !== false) {

        await showStageNotification(message.title, message.message);

      }

      if (message.stage === "api-sale-open" && state.options?.notifyOnSelect !== false) {

        await showStageNotification(message.title, message.message);

      }

      if (message.stage === "pay") {

        await showStageNotification(message.title, message.message);

      }

      return { ok: true };

    }



    if (message.type === "TICKPILOT_QUEUE_WIN") {

      const state = await readState();

      const winnerId = sender?.tab?.id;

      if (!winnerId) return { ok: false };

      if (state.runtime.queueWinner && state.runtime.queueWinner !== winnerId) {

        return { ok: true, already: true };

      }

      const next = await writeState({

        ...state,

        runtime: {

          ...state.runtime,

          queueWinner: winnerId,

          message: `Queue won on ${message.tabRole || "primary"} tab · stage=${message.stage}`,

        },

      });

      await yieldOtherTabs(winnerId, `winner reached ${message.stage}`);

      if (message.stage === "select") {

        await chrome.tabs.update(winnerId, { active: true });

      }

      return { ok: true, state: next };

    }



    if (message.type === "TICKPILOT_CHECK_PAGE") {

      const state = await readState();

      const liveTab = await findLiveTab();

      if (!liveTab?.id) {

        return { ok: false, error: "Open hkt.hkticketing.com event page first." };

      }

      let report = null;

      let diagnostics = null;

      for (let attempt = 0; attempt < 6; attempt += 1) {

        try {

          const res = await chrome.tabs.sendMessage(liveTab.id, {

            type: "LIVE_AUTO_SCAN",

            options: { ...state.options, ...(message.options || {}) },

          });

          report = res?.report;

          diagnostics = res?.diagnostics;

          break;

        } catch (_err) {

          await new Promise((r) => setTimeout(r, 400));

        }

      }

      if (!report) {

        return { ok: false, error: "Refresh the HKT tab once, then try again." };

      }

      const locale = diagnostics?.locale || "en";

      const apiLine = diagnostics?.api?.line;
      const targetLine = diagnostics?.api?.target || "";

      const line = `Check · ${report.stage} · ${locale} · buy: ${report.buyButton}`;

      const logLimit = state.options?.diagnostics !== false ? 48 : 24;

      const logs = appendLogs(
        state.runtime.logs,
        [line, ...(apiLine ? [apiLine] : []), ...(targetLine ? [targetLine] : [])],
        logLimit,
      );

      const next = await writeState({

        ...state,

        runtime: {

          ...state.runtime,

          connected: true,

          platform: state.options.platform === "kktix" ? "KKTIX" : "HKTicketing",

          logs,

          message: line,

          hkt: { stage: report.stage, stageLabel: report.stage, diagnostics },

        },

      });

      return { ok: true, state: next, report, diagnostics };

    }



    if (message.type === "TICKPILOT_CLEAR_LOG") {

      const state = await readState();

      return { ok: true, state: await writeState({ ...state, runtime: { ...state.runtime, logs: [] } }) };

    }



    if (message.type === "TICKPILOT_LIVE_AUTO_STATUS") {

      const state = await readState();

      const stage = message.stage || "unknown";

      const stageLabels = {

        login: "Login", event: "Event", waitingRoom: "Waiting room", busy: "Queue", select: "Select tickets",

        seat: "Seat map", confirm: "Confirm", pay: "Payment", complete: "Complete",

      };

      const next = await writeState({

        ...state,

        runtime: {

          ...state.runtime,

          running: Boolean(message.running),

          connected: true,

          platform: state.options.platform === "kktix" ? "KKTIX" : "HKTicketing",

          message: message.running ? `Running · ${stageLabels[stage] || stage}` : "Bot stopped.",

          hkt: { stage, stageLabel: stageLabels[stage] || stage },

        },

      });

      await setBadge(Boolean(message.running));

      return { ok: true, state: next };

    }



    if (message.type === "TICKPILOT_DIAG_SNAPSHOT") {

      const state = await readState();

      const snap = message.snapshot || {};

      const summary =

        `DIAG ${snap.stage} · tiers ${snap.tiers?.enabled}/${snap.tiers?.total} · ` +

        `next=${snap.nextBtn} pay=${snap.payBtn}`;

      const next = await writeState({

        ...state,

        runtime: {

          ...state.runtime,

          connected: true,

          message: summary,

          hkt: {

            ...(state.runtime.hkt || {}),

            stage: snap.stage,

            stageLabel: snap.stage,

            diagnostics: snap,

          },

        },

      });

      return { ok: true, state: next };

    }



    if (message.type === "TICKPILOT_LIVE_LOG") {

      const state = await readState();

      const entry = message.entry || {};

      const line = `[${entry.at}] ${entry.text}`;

      const logLimit = state.options?.diagnostics !== false ? 48 : 24;

      const logs = appendLogs(state.runtime.logs, [line], logLimit);

      const next = await writeState({

        ...state,

        runtime: {

          ...state.runtime,

          connected: true,

          platform: state.options.platform === "kktix" ? "KKTIX" : "HKTicketing",

          logs,

          message: entry.text || state.runtime.message,

          hkt: state.runtime.hkt || { stage: entry.stage, stageLabel: entry.stage },

        },

      });

      return { ok: true, state: next };

    }



    return { ok: false, error: "Unhandled message." };

  };



  handle().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));

  return true;

});


