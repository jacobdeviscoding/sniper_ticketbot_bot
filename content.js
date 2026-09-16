// LiveAuto is loaded before content.js (see manifest); make sure it's ready
(function initTickPilotLiveAssist() {
  const STAGE_LABELS = {
    busy: "Virtual queue",
    select: "Ticket selection",
    seat: "Seat map / allocation",
    confirm: "Order review",
    pay: "Payment",
    legacy: "Legacy site",
    event: "Event listing",
    login: "Login",
    unknown: "Unknown page",
  };

  const STAGE_LABELS_ZH = {
    busy: "虛擬等候室",
    select: "選擇門票",
    seat: "座位 / 分配",
    confirm: "確認訂單",
    pay: "付款",
    legacy: "舊版網站",
    event: "活動詳情",
    login: "登入",
    unknown: "未知頁面",
  };

  const isMirror = () => document.body?.dataset?.hktMirror === "true";
  const MAX_TIMELINE = 14;

  let storedOptions = null;
  let mirrorBotActive = false;
  let timeline = [];
  let prevSnapshot = {};
  let bannerTimer = null;
  let activeBanner = null;

  function detectPlatform() {
    const host = location.hostname.replace(/^www\./, "");
    if (/^busy\./i.test(host) || /hkt\.hkticketing\.com$/i.test(host) || /hkticketing\.com$/i.test(host)) {
      return "HKTicketing";
    }
    if (/cityline\.com$/i.test(host)) return "Cityline";
    if (/(kktix\.com|kktix\.cc)$/i.test(host)) return "KKTIX";
    if (/urbtix\.hk$/i.test(host)) return "URBTIX";
    return "Unknown";
  }

  function detectHktStage() {
    const host = location.hostname;
    const hash = location.hash || "";
    const path = location.pathname || "";

    if (isMirror()) {
      if (document.body.dataset.hktBusy === "true" || /^#\/queue/i.test(hash)) return "busy";
    }
    if (/^busy\./i.test(host)) return "busy";
    if (/premier\.hkticketing\.com$/i.test(host)) return "legacy";
    if (/\/login/i.test(path) || /#\/login/i.test(hash)) return "login";
    if (/selectTicket/i.test(hash)) return "select";
    if (/seatMap|chooseSeat|seatAllocation/i.test(hash)) return "seat";
    if (/confirmOrder|orderConfirm/i.test(hash)) return "confirm";
    if (/payment|checkout/i.test(hash)) return "pay";
    if (/#\/allEvents/i.test(hash) || /\/allEvents/i.test(path)) return "event";
    return "unknown";
  }

  function visible(el) {
    return Boolean(el && el.offsetParent !== null);
  }

  function textOf(node) {
    return `${node.textContent || ""} ${node.getAttribute?.("aria-label") || ""} ${node.name || ""} ${node.id || ""}`.trim();
  }

  function countMatches(selector) {
    return [...document.querySelectorAll(selector)].filter(visible).length;
  }

  function firstText(pattern) {
    const nodes = [...document.querySelectorAll("body *")];
    const node = nodes.find((candidate) => visible(candidate) && pattern.test(textOf(candidate)));
    return node ? textOf(node) : "";
  }

  function queuePosition() {
    const text = firstText(/(?:queue|position|排隊位置|等候位置|前面有)\D{0,24}\d[\d,]*/i);
    const match = text.match(/(?:queue|position|排隊位置|等候位置|前面有)\D{0,24}(\d[\d,]*)/i);
    return match ? Number(match[1].replace(/,/g, "")) : null;
  }

  function hasText(pattern) {
    const nodes = [...document.querySelectorAll("button, a, label, span, div, p, h1, h2, h3")];
    return nodes.some((node) => visible(node) && pattern.test(textOf(node)));
  }

  function collectHktSignals(stage) {
    const sessions = countMatches('[class*="sessionList___"]');
    const categories = countMatches('[class*="levelItem___"]:not([class*="disableClass___"])');
    const disabledCategories = countMatches('[class*="levelItem___"][class*="disableClass___"]');
    const qtyStepper = countMatches('[class*="buyNum___"]');
    const nextBar = countMatches('[class*="sellTicketBottomBtnWrap___"], [class*="pcOrderBar___"]');
    const seatCanvas = countMatches('[class*="seatMap"], canvas, svg[class*="seat"]');
    const queueLabels = /queue|waiting room|virtual queue|排隊|等候|请稍候|請稍候|too many|访问人数/i;

    return {
      stage,
      stageLabel: STAGE_LABELS[stage] || STAGE_LABELS.unknown,
      stageLabelZh: STAGE_LABELS_ZH[stage] || STAGE_LABELS_ZH.unknown,
      hash: location.hash || "(no hash)",
      host: location.hostname,
      sessions,
      categories,
      disabledCategories,
      qtyStepper,
      nextBar,
      seatCanvas,
      queueText: hasText(queueLabels) || stage === "busy",
      queuePosition: queuePosition(),
      retryable: Boolean(document.querySelector("button:not([disabled]), a")) && Boolean(stage === "busy" || stage === "event"),
      captcha: Boolean(document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], [class*="captcha"]')),
      loggedInHint: !/#\/login/i.test(location.hash) && !/\/login/i.test(location.pathname),
    };
  }

  function collectGenericSignals(platform) {
    const nodes = [...document.querySelectorAll("button, a, input, select, [role='button']")];
    const blob = (node) => textOf(node).toLowerCase();
    const stage = platform === "KKTIX" && /\/registrations\//i.test(location.pathname) ? "select" : "unknown";
    return {
      stage,
      stageLabel: stage === "select" ? "Registration / select" : "Generic scan",
      stageLabelZh: stage === "select" ? "報名 / 選票" : "一般掃描",
      hash: location.hash || location.pathname || "(no route)",
      host: location.hostname,
      sessions: 0,
      categories: countMatches('[class*="price"], [class*="ticket-type"], [class*="levelItem"]'),
      disabledCategories: 0,
      qtyStepper: countMatches('[class*="quantity"], [class*="buyNum"]'),
      nextBar: nodes.some((n) => /next|下一步|continue|確認/.test(blob(n))),
      seatCanvas: false,
      queueText: nodes.some((n) => /queue|排隊|waiting room/.test(blob(n))),
      captcha: Boolean(document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"]')),
      loggedInHint: true,
    };
  }

  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get(["tickpilot"]);
      storedOptions = data.tickpilot?.options || null;
      mirrorBotActive = Boolean(data.tickpilot?.runtime?.botActive || data.tickpilot?.runtime?.running);
    } catch (_e) {
      storedOptions = null;
      mirrorBotActive = false;
    }
  }

  function nowStamp() {
    return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }

  function pushTimeline(text, priority = "info") {
    timeline.unshift({ at: nowStamp(), text, priority });
    if (timeline.length > MAX_TIMELINE) timeline.pop();
  }

  function playAlertSound() {
    if (!storedOptions?.alertSound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, 180);
    } catch (_e) {}
  }

  function showBanner(message, priority = "info") {
    let banner = document.getElementById("tickpilot-alert-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "tickpilot-alert-banner";
      document.documentElement.appendChild(banner);
    }
    banner.className = `tp-banner tp-banner-${priority} tp-banner-show`;
    banner.innerHTML = `<strong>TickPilot Assist</strong><span>${message}</span><button type="button" aria-label="Dismiss">×</button>`;
    banner.querySelector("button").onclick = () => banner.classList.remove("tp-banner-show");
    activeBanner = message;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove("tp-banner-show"), priority === "critical" ? 12000 : 7000);
  }

  function emitAlerts(alerts, signals) {
    if (!alerts.length || isMirror()) return;
    alerts.forEach((alert) => {
      pushTimeline(alert.message, alert.priority);
      showBanner(alert.message, alert.priority);
      if (alert.priority === "critical") playAlertSound();
      chrome.runtime.sendMessage({
        type: "TICKPILOT_LIVE_ALERT",
        alert: { ...alert, stage: signals.stage, host: location.hostname, hash: location.hash, at: Date.now() },
        options: storedOptions,
      }).catch(() => {});
    });
  }

  function renderSettingsCard(platform, signals) {
    let card = document.getElementById("tickpilot-live-settings");
    if (!card) {
      card = document.createElement("section");
      card.id = "tickpilot-live-settings";
      document.documentElement.appendChild(card);
    }
    const o = storedOptions || {};
    const onLive = !isMirror() && platform === "HKTicketing";
    const badge = onLive ? "ASSIST" : mirrorBotActive ? "BOT" : "DETECT";
    const badgeClass = onLive ? "assist" : mirrorBotActive ? "on" : "";

    card.innerHTML = `
      <div class="tp-live-head">
        <strong>TickPilot 設定</strong>
        <span class="tp-live-badge ${badgeClass}">${badge}</span>
      </div>
      <p class="tp-live-note">${onLive ? "Live assist — manual buy only. Alerts + countdown." : "Mirror / detect mode."}</p>
      <p class="tp-live-clock" id="tp-settings-clock">${LiveAssist.saleCountdown().label}</p>
      <dl class="tp-live-grid">
        <div><dt>Target session</dt><dd>#${o.sessionIndex ?? 1}</dd></div>
        <div><dt>Zone range</dt><dd>${o.zoneRange || "1-3"}</dd></div>
        <div><dt>Qty</dt><dd>${o.quantity ?? 2}</dd></div>
        <div><dt>Member</dt><dd>${o.memberNumber || "—"}</dd></div>
        <div><dt>Open tiers</dt><dd>${signals.categories}${signals.disabledCategories ? ` (+${signals.disabledCategories} off)` : ""}</dd></div>
        <div><dt>Assist</dt><dd>${o.liveAssistEnabled !== false ? "ON" : "off"}</dd></div>
      </dl>
      ${onLive && o.memberNumber ? `<button type="button" class="tp-copy-member" id="tp-copy-member">Copy member number</button>` : ""}`;

    card.querySelector("#tp-copy-member")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(o.memberNumber);
        const btn = card.querySelector("#tp-copy-member");
        if (btn) btn.textContent = "Copied — paste it yourself";
      } catch (_e) {}
    });

    document.body?.classList.toggle("tp-assist-live", onLive && o.liveAssistEnabled !== false);
    document.body?.classList.toggle("tp-bot-armed", !onLive && mirrorBotActive);
  }

  function renderHud(platform, signals) {
    const compact = storedOptions?.assistCompactHud;
    let root = document.getElementById("tickpilot-probe");
    if (!root) {
      root = document.createElement("aside");
      root.id = "tickpilot-probe";
      document.documentElement.appendChild(root);
    }

    const isHkt = platform === "HKTicketing";
    const locale = storedOptions?.locale || "zh-HK";
    const action = LiveAssist.actionFor(signals.stage, locale);
    const progress = LiveAssist.stageProgress(signals.stage);
    const priority = LiveAssist.priorityFor(signals.stage);

    const rows = isHkt
      ? [
          ["Stage", `${signals.stageLabelZh} · ${signals.stageLabel}`],
          ["Host", signals.host],
          ["Route", signals.hash.replace(/^#/, "")],
          ["Sessions", signals.sessions ? `${signals.sessions} visible` : "none"],
          ["Open tiers", signals.categories ? `${signals.categories} available` : "none"],
          ["Disabled", signals.disabledCategories || "0"],
          ["Qty stepper", signals.qtyStepper ? "visible" : "hidden"],
          ["Next bar", signals.nextBar ? "visible" : "hidden"],
          ["Queue position", signals.queuePosition ?? "unknown"],
          ["Retry state", signals.retryable ? "action available" : "waiting"],
          ["Captcha", signals.captcha ? "present" : "none"],
        ]
      : [
          ["Platform", platform],
          ["Route", signals.hash.replace(/^#/, "")],
          ["Ticket UI", signals.categories ? `${signals.categories} signals` : "none"],
          ["Captcha", signals.captcha ? "present" : "none"],
        ];

    const timelineHtml = timeline.length
      ? timeline.map((row) => `<li class="tp-tl-${row.priority}"><time>${row.at}</time> ${row.text}</li>`).join("")
      : `<li class="tp-tl-info"><time>${nowStamp()}</time> Watching page…</li>`;

    root.className = compact ? "tp-compact" : "";
    root.innerHTML = `
      <div class="tp-probe-head">
        <p class="tp-kicker">TickPilot · ${isMirror() ? "mirror" : "live assist"}</p>
        <span class="tp-stage-pill tp-pill-${priority}">${signals.stageLabelZh}</span>
      </div>
      <strong>${platform}</strong>
      <p class="tp-clock" id="tp-hud-clock">${LiveAssist.saleCountdown().label}</p>
      ${progress ? `<div class="tp-progress-steps" aria-hidden="true">${["login","event","busy","select","seat","confirm","pay"].map((s, i) =>
        `<i class="${i < progress ? "done" : s === signals.stage ? "active" : ""}"></i>`).join("")}</div>` : ""}
      <p class="tp-action">${action}</p>
      <p class="tp-note">Read-only · no clicks, refresh, or checkout.</p>
      ${compact ? "" : `<dl class="tp-grid">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>`}
      <div class="tp-timeline-wrap">
        <p class="tp-tl-title">Activity</p>
        <ul class="tp-timeline">${timelineHtml}</ul>
      </div>
      <button type="button" class="tp-collapse" id="tp-toggle-compact">${compact ? "Expand" : "Compact"}</button>
    `;

    root.querySelector("#tp-toggle-compact")?.addEventListener("click", async () => {
      const next = !storedOptions?.assistCompactHud;
      storedOptions = { ...storedOptions, assistCompactHud: next };
      await chrome.runtime.sendMessage({ type: "TICKPILOT_SAVE_OPTIONS", options: { assistCompactHud: next } });
      renderHud(platform, signals);
    });

    renderSettingsCard(platform, signals);
  }

  function publish(platform, signals) {
    const message = `${signals.stageLabel} on ${signals.host}`;

    chrome.runtime.sendMessage({
      type: "TICKPILOT_RUNTIME",
      runtime: {
        connected: true,
        running: false,
        platform,
        pageTitle: document.title || location.hostname,
        message,
        hkt: platform === "HKTicketing" ? {
          stage: signals.stage,
          stageLabel: signals.stageLabel,
          hash: signals.hash,
          host: signals.host,
          categories: signals.categories,
          sessions: signals.sessions,
          captcha: signals.captcha,
        } : null,
      },
    }).catch(() => {});
  }

  async function scan() {
    await loadSettings();
    const platform = detectPlatform();
    const signals = platform === "HKTicketing"
      ? collectHktSignals(detectHktStage())
      : collectGenericSignals(platform);

    if (!isMirror() && storedOptions?.liveAssistEnabled !== false) {
      const alerts = LiveAssist.diffAlerts(prevSnapshot, signals, storedOptions || {});
      emitAlerts(alerts, signals);
    }

    if (prevSnapshot.stage !== signals.stage && !isMirror()) {
      pushTimeline(`Stage → ${signals.stageLabel}`, LiveAssist.priorityFor(signals.stage));
    }

    prevSnapshot = { ...signals };
    renderHud(platform, signals);
    publish(platform, signals);
    return { platform, signals };
  }

  scan();

  setInterval(() => {
    const clock = LiveAssist.saleCountdown().label;
    const a = document.getElementById("tp-hud-clock");
    const b = document.getElementById("tp-settings-clock");
    if (a) a.textContent = clock;
    if (b) b.textContent = clock;
  }, 1000);

  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(scan, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  window.addEventListener("hashchange", scan);
  window.addEventListener("popstate", scan);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tickpilot) {
      storedOptions = changes.tickpilot.newValue?.options || storedOptions;
      mirrorBotActive = Boolean(changes.tickpilot.newValue?.runtime?.botActive || changes.tickpilot.newValue?.runtime?.running);
      scan();
    }
  });

  // ─── LiveAuto integration ────────────────────────────────────────────────
  function updateLiveAutoBadge(running, stage) {
    if (running) {
      chrome.runtime.sendMessage({
        type: "TICKPILOT_RUNTIME",
        runtime: {
          running: true,
          platform: "HKTicketing",
          botActive: true,
          message: `LiveAuto active — ${stage}`,
          hkt: { stage, stageLabel: STAGE_LABELS[stage] || stage },
        },
      }).catch(() => {});
    }
  }

  // Forward LiveAuto log events into HUD timeline
  window.addEventListener("tp-liveauto-log", (e) => {
    const { at, text, priority } = e.detail;
    timeline.unshift({ at, text, priority });
    if (timeline.length > MAX_TIMELINE) timeline.pop();
    // Refresh HUD
    const platform = detectPlatform();
    const signals = platform === "HKTicketing"
      ? collectHktSignals(detectHktStage())
      : collectGenericSignals(platform);
    renderHud(platform, signals);
  });

  // Start/stop LiveAuto when user triggers from popup
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.type) return;
    if (msg.type === "TICKPILOT_LIVE_AUTO_STATUS") {
      // LiveAuto status heartbeat — forward to background
      chrome.runtime.sendMessage({
        type: "TICKPILOT_RUNTIME",
        runtime: {
          running: msg.running,
          platform: "HKTicketing",
          botActive: msg.running,
          message: msg.running ? `LiveAuto · ${msg.stage}` : "LiveAuto stopped",
          hkt: { stage: msg.stage || detectHktStage(), stageLabel: STAGE_LABELS[msg.stage] || msg.stage || "unknown" },
        },
      }).catch(() => {});
      sendResponse({ ok: true });
    }
    if (msg.type === "LIVE_AUTO_STATUS_QUERY") {
      sendResponse({ ok: true, running: LiveAuto?.isRunning?.() || false });
    }
    return true;
  });
})();
