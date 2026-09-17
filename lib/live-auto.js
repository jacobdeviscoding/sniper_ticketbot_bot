/**
 * LiveAuto — HKTicketing / KKTIX automation.
 *
 * Core focus: (1) read-only stock radar while in queue, (2) post-queue
 * accelerator — API-guided session/tier pick, turbo select → confirm → pay assist.
 */
const LiveAuto = (() => {
  let running = false;
  let options = {};
  let timer = null;
  let reportInterval = null;
  let lastStage = "";
  let retryStage = "";
  let retries = 0;
  let queueStartedAt = 0;
  let tierPickOffset = 0;
  let selectStuckRetries = 0;
  let lastTierCount = 0;
  let lastDiagAt = 0;
  let lastDiagStage = "";
  let buyObserver = null;
  let queueObserver = null;
  let tabRole = "primary";
  let yielded = false;
  let lastQueuePos = null;
  let alertedStages = new Set();
  let buyClickedAt = 0;
  let buyClickLocked = false;
  let sessionRotateOffset = 0;
  let soldOutStopLogged = false;
  let lastApiSnapshot = null;
  let lastApiPollAt = 0;
  let apiPollBusy = false;
  let lastApiLogLine = "";
  let lastApiCanAddCart = false;
  let lastApiBestOffer = null;
  let apiSoldOutQueueTicks = 0;

  const MAX_RETRIES_DEFAULT = 200;
  const POST_QUEUE_STAGES = new Set(["select", "seat", "confirm"]);
  const BUY_CLICK_COOLDOWN_MS = 15000;
  const DIAG_HEARTBEAT_MS = 12000;
  const QUEUE_TIMEOUT_MS = 8 * 60 * 1000;
  const COLLECTION_QR_RE = /qr code|ticket collection with qr|collection with qr|kiosk|自助取票|取票.*qr/i;
  const COLLECTION_COURIER_RE = /courier|registered mail|速遞|寄送|delivery mail|delivery/i;

  const SEL = {
    sessionItem: '[class*="sessionList___"]',
    categoryItem: '[class*="levelItem___"], .kktix-price',
    categoryEnabled: '[class*="levelItem___"]:not([class*="disableClass___"]):not([disabled]), .kktix-price:not([disabled])',
    qtyStepper: '[class*="buyNum___"], .buyNum___abc',
    bottomBar: '[class*="sellTicketBottomBtnWrap___"], [class*="pcOrderBar___"]',
    agreement: '#agreement, #agree-terms, input[name="agreement"]',
    memberField: '#member_number, #kktix_member, input[name="member"], input[placeholder*="會員"], input[placeholder*="会员"]',
    verifyField: '#kktix_verify, input[name="verify"], input[name="verification"]',
    loginEmail: "#user_login, #login_email, #email, input[name='email']",
    loginPassword: "#user_password, #login_password, #password, input[name='password']",
    loginSubmit: "[data-action='login-submit'], button[type='submit']",
    buyTicketBtn: '#join-queue, [data-action="buy-ticket"], button.buyTicket___abc, [class*="buyTicket___"], [class*="buyBtn___"]',
    connectionRetry: '[data-action="connection-retry"], .hkt-conn-retry, [class*="connRetry"], [class*="retryBtn"]',
    errorBanner: '[class*="conn"], [class*="error"], [role="alert"], .hkt-conn-banner',
    kktixTerms: '#kktix-terms, #agree-terms',
    kktixPriceItem: '.kktix-price',
  };

  const NEXT_LABELS = ["Next", "下一步", "Confirm", "確認", "确认", "Continue", "繼續"];
  const ALLOCATE_LABELS = ["分配座位", "Seat allocation", "allocate", "Allocate", "確認", "Confirm"];
  const PAY_LABELS = ["Pay", "付款", "Checkout", "結帳", "Submit", "提交", "前往付款"];
  const LOGIN_LABELS = ["登入", "Login", "Sign in", "登錄"];
  const BUY_LABELS = [
    "立即購票", "立即购票", "Buy now", "Buy tickets", "Buy Tickets", "Buy ticket",
    "Purchase", "購票", "购票", "Join queue", "加入購票", "Go to purchase",
  ];
  const PURCHASE_WAIT_RE = /not available|coming soon|即將|即将|尚未|暂未|未開始|未开始|not on sale|sold out soon|未開售|未开售|start soon|will start soon|awaiting sale/i;
  const PURCHASE_READY_RE = /^(buy now|buy tickets|buy ticket|立即購票|立即购票|加入購票|join queue|购票|購票|enter waiting room|進入等候室|进入等候室)$/i;
  const PURCHASE_READY_LOOSE_RE = /\bbuy now\b|\bbuy tickets?\b|立即購票|立即购票|加入購票|\bjoin queue\b|enter waiting room/i;
  let lastHeartbeatAt = 0;
  let lastPurchaseLabel = "";
  const RETRY_LABELS = ["重試", "Retry", "Try again", "再試", "重新連線", "重新连接"];
  const DISMISS_LABELS = ["確定", "OK", "知道了", "关闭", "關閉", "返回", "Back", "继续", "繼續"];

  function log(msg, priority = "info") {
    const stamp = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const entry = { at: stamp, text: `[LiveAuto] ${msg}`, priority };
    window.dispatchEvent(new CustomEvent("tp-liveauto-log", { detail: entry }));
    chrome.runtime.sendMessage({
      type: "TICKPILOT_LIVE_LOG",
      entry: { ...entry, stage: lastStage },
    }).catch(() => {});
  }

  function queryAll(sel) {
    try {
      return [...document.querySelectorAll(sel)].filter((el) => el.offsetParent !== null);
    } catch (_e) {
      return [];
    }
  }

  function queryOne(sel) {
    try {
      return document.querySelector(sel);
    } catch (_e) {
      return null;
    }
  }

  function isVisible(el) {
    return Boolean(el && el.offsetParent !== null && !el.disabled && el.getAttribute("aria-disabled") !== "true");
  }

  function clickEl(el) {
    if (!isVisible(el)) return false;
    el.classList.add("tp-auto-click");
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    setTimeout(() => el.classList.remove("tp-auto-click"), 400);
    return true;
  }

  function classHas(el, token) {
    return Boolean(el && el.className && String(el.className).includes(token));
  }

  function isFunction1() {
    return Boolean(options.function1Enabled && !options.function2Enabled);
  }

  function detectPageLocale() {
    const path = location.pathname || "";
    if (/\/en(\/|$)/i.test(path)) return "en";
    if (/\/hant(\/|$)/i.test(path) || /\/zh(\/|$)/i.test(path)) return "zh";
    return options.locale === "zh" || options.locale === "zh-HK" ? "zh" : "en";
  }

  function applyEventPatchSelectors() {
    const patch = typeof getEventPatch === "function" ? getEventPatch(location.href) : null;
    if (!patch?.selectors) return patch;
    Object.assign(SEL, patch.selectors);
    if (patch.tierKeywords && !options.tierKeywords) {
      options.tierKeywords = patch.tierKeywords;
    }
    return patch;
  }

  function sessionMatchCandidates() {
    const list = [];
    const explicit = (options.sessionMatch || "").trim();
    if (explicit) list.push(explicit);
    const patch = typeof getEventPatch === "function" ? getEventPatch(location.href) : null;
    const locale = detectPageLocale();
    const idx = Math.max(0, (options.sessionIndex || 1) - 1);
    if (patch?.sessions?.[idx]) {
      list.push(...(locale === "en" ? patch.sessions[idx].en : patch.sessions[idx].zh));
    }
    const enDates = ["13 Nov", "14 Nov", "15 Nov"];
    const zhDates = ["11月13", "11月14", "11月15"];
    list.push(...(locale === "en" ? enDates : zhDates).filter((_, i) => i === idx));
    return [...new Set(list.filter(Boolean))];
  }

  function effectiveDelay(requested) {
    const ms = requested ?? options.interval ?? 500;
    const stage = lastStage || detectCurrentStage();
    const turbo = options.selectTurbo !== false && POST_QUEUE_STAGES.has(stage);
    if (turbo) {
      const jitter = 10 + Math.floor(Math.random() * 25);
      return Math.max(85, Math.min(ms, 130) + jitter);
    }
    if (options.antiBlock === false) return ms;
    const jitter = 25 + Math.floor(Math.random() * 75);
    const tuned = {
      event: ms,
      busy: Math.max(220, Math.min(ms, 380) - 90),
      waitingRoom: Math.max(280, Math.min(ms, 450) - 60),
      select: Math.max(150, Math.min(ms, 320) - 110),
      seat: Math.max(180, ms - 70),
      confirm: ms,
      pay: ms + 80,
    };
    return Math.max(120, (tuned[stage] ?? ms) + jitter);
  }

  function isRadarStage(stage = lastStage || detectCurrentStage()) {
    return stage === "event" || stage === "waitingRoom" || stage === "busy";
  }

  function schedulePost(ms) {
    schedule(ms);
  }

  function playAlertSound() {
    if (options.soundAlert === false) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 180);
    } catch (_e) {}
  }

  function notifyStageChange(stage) {
    if (alertedStages.has(stage)) return;
    if (stage === "waitingRoom") {
      alertedStages.add(stage);
      log("Waiting room — stay on this tab until 12:00 HKT (no refresh)", "info");
    }
    if (stage === "select" && options.notifyOnSelect !== false) {
      alertedStages.add(stage);
      playAlertSound();
      const target = lastApiBestOffer && typeof HktApi !== "undefined"
        ? HktApi.formatBestOfferLine(lastApiBestOffer)
        : "";
      log(target ? `Post-queue accelerator · ${target}` : "Post-queue accelerator — picking tickets", "info");
      chrome.runtime.sendMessage({
        type: "TICKPILOT_STAGE_ALERT",
        stage,
        tabRole,
        title: "TickPilot — Select page",
        message: target || "Queue cleared. Bot is picking tickets.",
      }).catch(() => {});
    }
    if (stage === "pay") {
      alertedStages.add(stage);
      chrome.runtime.sendMessage({
        type: "TICKPILOT_STAGE_ALERT",
        stage,
        tabRole,
        title: "TickPilot — Payment",
        message: "Pay with Visa within 5 minutes.",
      }).catch(() => {});
    }
    if (["select", "confirm", "pay"].includes(stage)) {
      chrome.runtime.sendMessage({
        type: "TICKPILOT_QUEUE_WIN",
        stage,
        tabRole,
        url: location.href,
      }).catch(() => {});
    }
  }

  function formatCountdownMs(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function parseHktSaleTimeMs() {
    const text = pageText();
    const m = text.match(/On-sale date and time:\s*(\d{1,2})\s+(\w+)\s+(\d{4}),?\s*(\d{1,2}):(\d{2})/i);
    if (!m) return null;
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = months[m[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    const iso = `${m[3]}-${String(month + 1).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}T${String(m[4]).padStart(2, "0")}:${m[5]}:00+08:00`;
    const sale = Date.parse(iso);
    return Number.isNaN(sale) ? null : sale;
  }

  function timerLeafNodes(root) {
    const timerRe = /^(\d{2}):(\d{2}):(\d{2})$/;
    if (!root) return [];
    return [...root.querySelectorAll("*")].filter((el) => {
      if (el.children.length > 0 || !el.offsetParent) return false;
      return timerRe.test((el.textContent || "").trim());
    });
  }

  function pickBestTimer(leaves) {
    if (!leaves.length) return null;
    if (leaves.length === 1) return leaves[0].textContent.trim();
    const sized = leaves
      .map((el) => ({
        text: el.textContent.trim(),
        size: parseFloat(window.getComputedStyle(el).fontSize) || 0,
      }))
      .sort((a, b) => b.size - a.size);
    return sized[0].text;
  }

  function findDomCountdownTimer() {
    const timerRe = /^(\d{2}):(\d{2}):(\d{2})$/;

    for (const el of document.querySelectorAll("*")) {
      if (!el.offsetParent || el.children.length > 0) continue;
      if (!/^starts in$/i.test((el.textContent || "").trim())) continue;
      let box = el.parentElement;
      for (let depth = 0; depth < 8 && box; depth += 1) {
        const leaves = timerLeafNodes(box);
        const pick = pickBestTimer(leaves);
        if (pick) return pick;
        box = box.parentElement;
      }
    }

    for (const el of document.querySelectorAll("*")) {
      if (!el.offsetParent) continue;
      const text = (el.textContent || "").trim();
      if (!/starts in/i.test(text) || text.length > 80) continue;
      const pick = pickBestTimer(timerLeafNodes(el));
      if (pick) return pick;
    }

    const classHits = document.querySelectorAll(
      '[class*="countdown"], [class*="Countdown"], [class*="timer"], [class*="Timer"]',
    );
    for (const box of classHits) {
      if (!box.offsetParent) continue;
      const pick = pickBestTimer(timerLeafNodes(box));
      if (pick) return pick;
    }

    return null;
  }

  function getWaitingRoomCountdown() {
    const dom = findDomCountdownTimer();
    if (dom) return dom;

    const saleMs = parseHktSaleTimeMs();
    if (saleMs != null) {
      return `${formatCountdownMs(saleMs - Date.now())} (PC clock — sync Windows time to HKT)`;
    }
    return null;
  }

  function watchPurchaseButton() {
    if (buyObserver) buyObserver.disconnect();
    buyObserver = new MutationObserver(() => {
      if (!running || yielded || buyClickLocked || detectCurrentStage() !== "event") return;
      if (tabRole === "backup") return;
      const btn = findBuyButton();
      if (btn && Date.now() - buyClickedAt > BUY_CLICK_COOLDOWN_MS) tick().catch(() => {});
    });
    if (document.body) {
      buyObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }
  }

  function watchQueueAdvance() {
    if (queueObserver) queueObserver.disconnect();
    queueObserver = new MutationObserver(() => {
      if (!running || yielded) return;
      const stage = detectCurrentStage();
      if (stage === "select" || stage === "busy" ||
        (/selectTicket/i.test(location.hash) && !/^busy\./i.test(location.hostname))) {
        tick().catch(() => {});
      }
    });
    if (document.body) {
      queueObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function disconnectObservers() {
    if (buyObserver) buyObserver.disconnect();
    if (queueObserver) queueObserver.disconnect();
    buyObserver = null;
    queueObserver = null;
  }

  function pageText() {
    return document.body?.innerText || "";
  }

  function bodyHasError() {
    return /連線錯誤|连接错误|系統繁忙|系统繁忙|too many|訪問人數|访问人数|server error|稍後再試|稍后再试|connection failed|busy/i.test(pageText());
  }

  function parseZone(text) {
    const m = String(text).match(/zone[:\s]*(\d+)/i);
    return m ? parseInt(m[1], 10) : 99;
  }

  function parsePrice(text) {
    const m = String(text).match(/HK[\$\s]*([\d,]+)/);
    return m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
  }

  function parseZoneRange(text) {
    const m = String(text || "1-99").match(/(\d+)\s*-\s*(\d+)/);
    if (!m) return { min: 1, max: 99 };
    return { min: Math.min(+m[1], +m[2]), max: Math.max(+m[1], +m[2]) };
  }

  function matchesFilters(el) {
    const o = options;
    if (o.skipObstructed !== false) {
      if (el.dataset.obs === "1" || /視線受阻|obstructed/i.test(el.textContent)) return false;
    }
    if (o.skipWheelchair !== false) {
      if (el.dataset.wc === "1" || /輪椅|wheelchair/i.test(el.textContent)) return false;
    }
    const zone = parseInt(el.dataset.zone || parseZone(el.textContent), 10);
    if (!Number.isNaN(zone) && zone !== 99) {
      const range = parseZoneRange(o.zoneRange);
      if (zone < range.min || zone > range.max) return false;
    }
    const price = parsePrice(el.textContent);
    if (!Number.isNaN(price)) {
      if (price < (o.minPrice || 0)) return false;
      if (price > (o.maxPrice || 100000)) return false;
    }
    return true;
  }

  function buttonPools() {
    const bar = queryOne(SEL.bottomBar);
    return [
      queryOne("button.hkt-next:not([disabled])"),
      queryOne("button.hkt-allocate:not([disabled])"),
      queryOne("button.hkt-pay:not([disabled])"),
      ...(bar ? [...bar.querySelectorAll("button, a")] : []),
      ...[...document.querySelectorAll("button.bui-btn-primary, a.bui-btn-primary")],
      ...[...document.querySelectorAll("button, a[role='button']")],
    ].filter(Boolean);
  }

  function findButtonByLabels(labels, extra = []) {
    const seen = new Set();
    const pools = [extra.filter(Boolean), buttonPools()];
    for (const label of labels) {
      for (const pool of pools) {
        for (const el of pool) {
          if (!el || seen.has(el) || !isVisible(el)) continue;
          seen.add(el);
          const text = el.textContent.trim();
          if (text === label || new RegExp(`^${label}$`, "i").test(text)) return el;
        }
      }
    }
    return null;
  }

  function isNoisePurchaseCandidate(el) {
    const text = (el.textContent || "").trim();
    return /^(search|login|log in|登入|登录|back to top|cookie)/i.test(text);
  }

  function findBuyButtonCandidates() {
    const nodes = new Set();
    const selectors = [
      SEL.buyTicketBtn,
      "button.bui-btn-large.bui-btn-primary",
      "button.bui-btn-primary.bui-btn-large",
      "[class*='buyTicket']",
      "[class*='buyBtn']",
      "button, a, [role='button']",
    ];
    selectors.forEach((sel) => {
      try {
        document.querySelectorAll(sel).forEach((el) => nodes.add(el));
      } catch (_e) {}
    });
    return [...nodes].filter((el) => el && !isNoisePurchaseCandidate(el));
  }

  function describeBuyButton(el) {
    if (!el) return "none";
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
    const vis = el.offsetParent !== null;
    const state = PURCHASE_READY_RE.test(text) ? "ready" : PURCHASE_WAIT_RE.test(text) ? "waiting" : "unknown";
    return `"${text}" · ${state} · ${disabled ? "disabled" : "enabled"} · ${vis ? "visible" : "hidden"}`;
  }

  function findPurchaseButton() {
    const candidates = findBuyButtonCandidates().filter((el) => el.offsetParent !== null);
    const primary = candidates.find((el) => {
      const cls = String(el.className || "");
      return /bui-btn-large/.test(cls) && /bui-btn-primary/.test(cls);
    });
    if (primary) return primary;
    return candidates.find((el) => {
      const text = normalizePurchaseText(el.textContent);
      return PURCHASE_READY_LOOSE_RE.test(text) || PURCHASE_WAIT_RE.test(text) || /not available|buy|購票|购票/i.test(text);
    }) || null;
  }

  function normalizePurchaseText(text) {
    return String(text || "").trim().replace(/\s+/g, " ");
  }

  function isPurchaseReady(el) {
    if (!el || el.offsetParent === null) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const text = normalizePurchaseText(el.textContent);
    if (!text || PURCHASE_WAIT_RE.test(text)) return false;
    if (/not available/i.test(text)) return false;
    if (PURCHASE_READY_RE.test(text)) return true;
    return PURCHASE_READY_LOOSE_RE.test(text);
  }

  function findBuyButton() {
    const btn = findPurchaseButton();
    return btn && isPurchaseReady(btn) ? btn : null;
  }

  function heartbeat(msg, ms = 8000) {
    const now = Date.now();
    if (now - lastHeartbeatAt >= ms) {
      lastHeartbeatAt = now;
      log(msg, "info");
    }
  }

  function scanPage() {
    const stage = detectCurrentStage();
    const buyCandidates = findBuyButtonCandidates().filter((el) => el.offsetParent !== null);
    const purchaseBtn = findPurchaseButton();
    const buyBtn = findBuyButton();
    return {
      stage,
      locale: detectPageLocale(),
      sessionCandidates: sessionMatchCandidates(),
      url: location.href,
      host: location.hostname,
      hash: location.hash,
      buyButton: describeBuyButton(buyBtn || purchaseBtn || buyCandidates[0]),
      purchaseLabel: (purchaseBtn?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
      purchaseReady: Boolean(buyBtn),
      buyCandidates: buyCandidates.length,
      sessions: queryAll(SEL.sessionItem).length,
      tiers: queryAll(SEL.categoryEnabled).length,
      running,
      tierFilter: `HK$${options.minPrice || 0}-${options.maxPrice || 0} · ${options.tierKeywords || "any"}`,
    };
  }

  function logScanReport() {
    const s = scanPage();
    log(`Scan · stage=${s.stage} · purchase=${s.buyButton} · ${s.buyCandidates} candidate(s)`, "info");
    if (s.stage === "event" && s.purchaseLabel && !s.purchaseReady) {
      log(`Purchase CTA found: "${s.purchaseLabel}" — will auto-click when sale opens`, "info");
    }
    if (s.stage === "event" && !s.purchaseLabel) {
      log("Event page — purchase button not found (log in & refresh tab)", "warn");
    }
    if (s.stage === "unknown") {
      log("Page not recognized — open BIGBANG event detail URL", "warn");
    }
    if (s.tiers > 0) {
      log(`Select page · ${s.sessions} session(s) · ${s.tiers} tier(s) · filter: ${s.tierFilter}`, "info");
    }
    if (options.diagnostics !== false) {
      logStageDiagnostics("scan");
    }
    return s;
  }

  function clipText(text, max = 48) {
    return String(text || "").trim().replace(/\s+/g, " ").slice(0, max);
  }

  function findCollectionOptions() {
    const nodes = new Set();
    const selectors = [
      '[class*="collect"]',
      '[class*="delivery"]',
      '[class*="ticketType"]',
      '[class*="receiveType"]',
      '[class*="sendType"]',
      '[class*="pickup"]',
      '[class*="receiveWay"]',
      '[class*="getTicket"]',
    ];
    selectors.forEach((sel) => {
      try {
        document.querySelectorAll(sel).forEach((el) => nodes.add(el));
      } catch (_e) {}
    });
    document.querySelectorAll('input[type="radio"], label, [role="radio"]').forEach((el) => {
      const text = clipText(el.textContent || el.getAttribute("aria-label"), 80);
      if (/qr|kiosk|courier|取票|寄送|collection|pickup|delivery|ticket collection/i.test(text)) {
        nodes.add(el);
      }
    });
    return [...nodes]
      .filter((el) => el.offsetParent !== null)
      .slice(0, 12)
      .map((el) => {
        const input = el.matches("input") ? el : el.querySelector?.('input[type="radio"]');
        const clickTarget = input?.closest("label") || el.closest("label") || input || el;
        return {
          el: clickTarget,
          text: clipText(el.textContent || el.value || el.getAttribute("aria-label"), 55),
          checked: Boolean(input?.checked),
          disabled: Boolean(input?.disabled || el.disabled || el.getAttribute("aria-disabled") === "true"),
          isQr: COLLECTION_QR_RE.test(el.textContent || ""),
          isCourier: COLLECTION_COURIER_RE.test(el.textContent || ""),
        };
      });
  }

  async function handleCollectionMethod() {
    if (options.autoCollection === false) return false;
    const opts = findCollectionOptions();
    if (!opts.length) return false;
    if (opts.some((o) => o.checked)) return false;
    const prefer = options.collectionMethod || "qr";
    let pick = prefer === "qr"
      ? opts.find((o) => o.isQr && !o.disabled)
      : opts.find((o) => o.isCourier && !o.disabled);
    if (!pick) pick = opts.find((o) => !o.disabled);
    if (!pick?.el) return false;
    if (clickEl(pick.el)) {
      log(`Collection method: ${pick.text.slice(0, 50)}`, "info");
      return true;
    }
    return false;
  }

  function collectStageDiagnostics() {
    const stage = detectCurrentStage();
    const sessions = queryAll(SEL.sessionItem);
    const allCats = queryAll(SEL.categoryItem);
    const enabledCats = queryAll(SEL.categoryEnabled);
    const stepper = queryOne(SEL.qtyStepper);
    const agree = queryOne(SEL.agreement) || queryOne('input[type="checkbox"]');
    const member = queryOne(SEL.memberField);
    const visibleButtons = buttonPools()
      .filter(isVisible)
      .slice(0, 14)
      .map((el) => clipText(el.textContent, 32));

    let qty = null;
    if (stepper?.children?.[1]) {
      qty = clipText(stepper.children[1].textContent, 8);
    }

    const paymentIframe = document.querySelector(
      'iframe[src*="payment"], iframe[src*="checkout"], iframe[src*="pay"], iframe[src*="secure"], iframe[src*="alipay"], iframe[src*="wechat"]',
    );

    return {
      at: new Date().toISOString(),
      reason: "",
      locale: detectPageLocale(),
      tabRole,
      stage,
      url: location.href,
      host: location.hostname,
      hash: location.hash,
      queuePos: getQueuePosition(),
      bodyError: bodyHasError(),
      purchase: describeBuyButton(findPurchaseButton()),
      sessions: sessions.map((s, i) => ({
        i,
        text: clipText(s.textContent, 42),
        selected: classHas(s, "fouceStyle___sel"),
        disabled: Boolean(s.disabled || classHas(s, "disableClass___")),
      })),
      tiers: {
        total: allCats.length,
        enabled: enabledCats.length,
        items: allCats.slice(0, 12).map((c, i) => ({
          i,
          text: clipText(c.textContent, 52),
          price: parsePrice(c.textContent),
          enabled: !classHas(c, "disableClass___") && !c.disabled,
          selected: classHas(c, "reminderStyle___sel") || c.classList.contains("selected"),
        })),
      },
      qty,
      collection: findCollectionOptions().map((c) => ({
        text: c.text,
        checked: c.checked,
        disabled: c.disabled,
      })),
      memberVisible: Boolean(member && member.offsetParent !== null),
      memberFilled: Boolean(member?.value?.trim()),
      agreeVisible: Boolean(agree && agree.offsetParent !== null),
      agreeChecked: Boolean(agree?.checked),
      nextBtn: Boolean(findButtonByLabels(NEXT_LABELS)),
      allocateBtn: Boolean(findButtonByLabels(ALLOCATE_LABELS)),
      payBtn: Boolean(findPayButton()),
      retryBtn: Boolean(findConnectionRetry()),
      paymentIframe: Boolean(paymentIframe),
      buttons: visibleButtons,
      retries,
      retryStage,
      api: lastApiSnapshot
        ? {
          fullySoldOut: lastApiSnapshot.fullySoldOut,
          canAddCart: lastApiSnapshot.canAddCart,
          line: typeof HktApi !== "undefined" ? HktApi.formatStockLine(lastApiSnapshot) : "",
          target: typeof HktApi !== "undefined" ? HktApi.formatBestOfferLine(lastApiBestOffer) : "",
        }
        : null,
    };
  }

  function sendDiagSnapshot(snapshot) {
    chrome.runtime.sendMessage({
      type: "TICKPILOT_DIAG_SNAPSHOT",
      snapshot,
    }).catch(() => {});
  }

  function logStageDiagnostics(reason = "probe", force = false) {
    if (options.diagnostics === false) return null;
    const stage = detectCurrentStage();
    const now = Date.now();
    const critical = ["busy", "select", "seat", "confirm", "pay", "unknown"];
    if (!force && !critical.includes(stage) && reason !== "scan" && reason !== "stage-change") {
      return null;
    }
    if (!force && reason === "heartbeat" && now - lastDiagAt < DIAG_HEARTBEAT_MS) {
      return null;
    }
    if (!force && reason !== "stage-change" && reason !== "scan" && stage === lastDiagStage && now - lastDiagAt < 4000) {
      return null;
    }

    const d = collectStageDiagnostics();
    d.reason = reason;
    lastDiagAt = now;
    lastDiagStage = stage;

    log(
      `DIAG [${reason}] stage=${d.stage} host=${d.host} queue=${d.queuePos ?? "-"} ` +
      `sessions=${d.sessions.length} tiers=${d.tiers.enabled}/${d.tiers.total} qty=${d.qty ?? "-"} ` +
      `next=${d.nextBtn} pay=${d.payBtn} retry=${d.retryBtn}`,
      "info",
    );

    d.sessions.forEach((s) => {
      log(`  session[${s.i}]: ${s.selected ? "SEL" : "—"} ${s.disabled ? "OFF" : "OK"} · ${s.text}`, "info");
    });

    d.tiers.items.forEach((t) => {
      const flag = t.selected ? "SEL" : t.enabled ? "OK" : "OFF";
      const price = Number.isNaN(t.price) ? "?" : t.price;
      log(`  tier[${t.i}]: ${flag} HK$${price} · ${t.text}`, "info");
    });

    if (d.collection.length) {
      d.collection.forEach((c, i) => {
        log(`  collection[${i}]: ${c.checked ? "SEL" : "—"} ${c.disabled ? "OFF" : "OK"} · ${c.text}`, "warn");
      });
    } else if (["select", "confirm", "seat"].includes(d.stage)) {
      log("  collection: none detected — watch for ticket pickup step", "warn");
    }

    if (d.buttons.length) {
      log(`  buttons: ${d.buttons.join(" · ")}`, "info");
    }
    if (d.bodyError) {
      log("  BODY ERROR text detected on page", "warn");
    }
    if (d.paymentIframe) {
      log("  payment iframe detected — pay manually within 5 min", "warn");
    }
    if (d.memberVisible) {
      log(`  member field: ${d.memberFilled ? "filled" : "empty"}`, "info");
    }

    sendDiagSnapshot(d);
    return d;
  }

  function diagOnStuck(stage) {
    if (options.diagnostics === false) return;
    if (!["select", "seat", "confirm", "pay", "busy", "unknown"].includes(stage)) return;
    if (retries > 0 && retries % 15 === 0) {
      logStageDiagnostics(`stuck-r${retries}`, true);
    }
  }

  function findConnectionRetry() {
    const direct = queryOne(SEL.connectionRetry);
    if (direct && isVisible(direct)) return direct;
    if (bodyHasError()) return findButtonByLabels(RETRY_LABELS);
    return null;
  }

  function recoverFromError() {
    const retry = findConnectionRetry();
    if (retry && clickEl(retry)) {
      log("Connection / server error — retry clicked", "warn");
      logStageDiagnostics("error-retry", true);
      return true;
    }
    if (bodyHasError()) {
      const dismiss = findButtonByLabels(DISMISS_LABELS);
      if (dismiss && clickEl(dismiss)) {
        log("Dismissed error dialog", "warn");
        return true;
      }
    }
    return false;
  }

  function clickNext() {
    const direct = queryOne("button.hkt-next:not([disabled]), button.hkt-allocate:not([disabled]), button.hkt-pay:not([disabled])");
    if (direct && clickEl(direct)) return true;
    const btn = findButtonByLabels(NEXT_LABELS);
    return btn ? clickEl(btn) : false;
  }

  function findPayButton() {
    const direct = queryOne("button.hkt-pay:not([disabled])");
    if (direct && isVisible(direct)) return direct;
    return findButtonByLabels(PAY_LABELS);
  }

  function getQueuePosition() {
    const m = pageText().match(/(?:queue|position|排隊位置|等候位置|排隊|前面有)\D{0,24}(\d[\d,]*)/i);
    return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
  }

  function bumpRetry(reason) {
    const stage = detectCurrentStage();
    if (stage !== retryStage) {
      retryStage = stage;
      retries = 0;
    }
    retries += 1;
    diagOnStuck(retryStage || detectCurrentStage());
    if (retries > (options.maxRetries || MAX_RETRIES_DEFAULT)) {
      logStageDiagnostics(`max-retries-${reason}`, true);
      throw new Error(reason || "max retries");
    }
  }

  function schedule(delay) {
    clearTimeout(timer);
    const ms = effectiveDelay(delay);
    timer = setTimeout(() => {
      tick().catch((err) => {
        log(`Recovered: ${err.message}`, "warn");
        schedule(options.interval || 500);
      });
    }, ms);
  }

  function isSoldOutText(text) {
    return /sold out|售罄|已售完/i.test(String(text || ""));
  }

  function isSessionSoldOut(el) {
    if (!el) return true;
    return isSoldOutText(el.textContent) || el.disabled || classHas(el, "disableClass___");
  }

  function isTierSoldOut(el) {
    return !el || el.disabled || classHas(el, "disableClass___") || isSoldOutText(el.textContent);
  }

  function allTiersSoldOut(allCats) {
    return allCats.length > 0 && allCats.every(isTierSoldOut);
  }

  function allSessionsSoldOut(sessions) {
    return sessions.length > 0 && sessions.every(isSessionSoldOut);
  }

  function isGlobalSoldOutPage() {
    const sessions = queryAll(SEL.sessionItem);
    const allCats = queryAll(SEL.categoryItem);
    if (!sessions.length && !allCats.length) return false;
    if (allSessionsSoldOut(sessions) && allTiersSoldOut(allCats)) return true;
    const barBtn = buttonPools().find((b) => isVisible(b) && /^sold out$/i.test((b.textContent || "").trim()));
    return Boolean(barBtn && allTiersSoldOut(allCats));
  }

  function rankedTiersRelaxed(cats) {
    const saved = options.tierKeywords;
    options.tierKeywords = "";
    const result = rankedTiers(cats);
    options.tierKeywords = saved;
    return result;
  }

  function pickAvailableSession(sessions) {
    const available = sessions.filter((s) => !isSessionSoldOut(s));
    if (!available.length) return null;

    if (options.rotateSessions !== false) {
      const startIdx = Math.max(0, (options.sessionIndex || 1) - 1);
      for (let i = 0; i < sessions.length; i += 1) {
        const idx = (startIdx + sessionRotateOffset + i) % sessions.length;
        const s = sessions[idx];
        if (s && !isSessionSoldOut(s)) return s;
      }
    }

    for (const match of sessionMatchCandidates()) {
      const found = available.find((s) => s.textContent.includes(match));
      if (found) return found;
    }
    return available[0];
  }

  async function tryNextSession(sessions) {
    if (options.rotateSessions === false || !sessions.length) return false;
    sessionRotateOffset = (sessionRotateOffset + 1) % sessions.length;
    const next = pickAvailableSession(sessions);
    if (next && clickEl(next)) {
      log(`Next date: ${clipText(next.textContent, 55)}`, "warn");
      lastTierCount = 0;
      retries = 0;
      schedule(250);
      return true;
    }
    return false;
  }

  function stopAllSoldOut(reason) {
    if (soldOutStopLogged) {
      schedule(3000);
      return;
    }
    soldOutStopLogged = true;
    log(reason, "warn");
    log("Everything SOLD OUT — stopping bot (no tickets to buy)", "warn");
    stop();
  }

  function apiPollInterval(stage = detectCurrentStage()) {
    if (POST_QUEUE_STAGES.has(stage)) return options.apiPollMsSelect || 600;
    if (stage === "busy" || stage === "waitingRoom" || isInHktQueue()) {
      return options.apiPollMsQueue || 900;
    }
    return options.apiPollMs || 1500;
  }

  function updateApiBestOffer(summary) {
    if (!summary || summary.fullySoldOut || typeof HktApi === "undefined") {
      lastApiBestOffer = null;
      return null;
    }
    lastApiBestOffer = HktApi.pickBestOffer(summary, options);
    return lastApiBestOffer;
  }

  function maybeStopRadarSoldOut(summary) {
    if (options.apiStopInQueue === false || !summary?.fullySoldOut) {
      apiSoldOutQueueTicks = 0;
      return;
    }
    if (!isRadarStage()) {
      apiSoldOutQueueTicks = 0;
      return;
    }
    apiSoldOutQueueTicks += 1;
    if (apiSoldOutQueueTicks >= 2) {
      stopAllSoldOut("Radar: ALL SOLD OUT during queue — stopping (no inventory left)");
    }
  }

  async function refreshApiStock(force = false) {
    if (options.apiRadar === false || typeof HktApi === "undefined") return lastApiSnapshot;
    const stage = detectCurrentStage();
    const interval = apiPollInterval(stage);
    if (!force && Date.now() - lastApiPollAt < interval) return lastApiSnapshot;
    if (apiPollBusy) return lastApiSnapshot;

    const token = HktApi.getProjectToken(options.eventProjectId);
    if (!token) return null;

    apiPollBusy = true;
    try {
      const lang = HktApi.langTypeFromLocale(detectPageLocale());
      const json = await HktApi.fetchProject(token, lang);
      lastApiSnapshot = HktApi.analyzeProject(json);
      lastApiPollAt = Date.now();
      updateApiBestOffer(lastApiSnapshot);
      maybeAlertApiSaleOpen(lastApiSnapshot);
      maybeStopRadarSoldOut(lastApiSnapshot);
      return lastApiSnapshot;
    } catch (err) {
      log(`Radar poll failed: ${err.message}`, "warn");
      return lastApiSnapshot;
    } finally {
      apiPollBusy = false;
    }
  }

  function logApiStock(force = false) {
    if (!lastApiSnapshot || typeof HktApi === "undefined") return;
    const line = HktApi.formatStockLine(lastApiSnapshot);
    if (force || line !== lastApiLogLine) {
      lastApiLogLine = line;
      log(line, lastApiSnapshot.fullySoldOut ? "warn" : "info");
    }
  }

  function maybeAlertApiSaleOpen(summary) {
    if (!summary?.canAddCart || lastApiCanAddCart || alertedStages.has("api-sale-open")) return;
    lastApiCanAddCart = true;
    alertedStages.add("api-sale-open");
    log("API · SALE OPEN — canAddCart=true · Buy should enable", "info");
    playAlertSound();
    chrome.runtime.sendMessage({
      type: "TICKPILOT_STAGE_ALERT",
      stage: "api-sale-open",
      tabRole,
      title: "TickPilot — Sale open",
      message: "API confirms add-to-cart is live. Watch for Buy button.",
    }).catch(() => {});
  }

  function getApiStatusLine() {
    if (!lastApiSnapshot || typeof HktApi === "undefined") return "";
    return HktApi.formatStockLine(lastApiSnapshot);
  }

  function getApiBestOfferLine() {
    if (!lastApiBestOffer || typeof HktApi === "undefined") return "";
    return HktApi.formatBestOfferLine(lastApiBestOffer);
  }

  function getHudMode() {
    if (!running) return "idle";
    const stage = lastStage || detectCurrentStage();
    if (POST_QUEUE_STAGES.has(stage)) return "accelerate";
    if (isRadarStage(stage)) return "radar";
    return "armed";
  }

  function findDomTierForApiPrice(allCats, apiPrice) {
    const pool = allCats.filter((c) => !isTierSoldOut(c));
    if (!pool.length) return null;
    if (typeof HktApi !== "undefined" && HktApi.tierDomScore) {
      return pool
        .map((el) => ({ el, score: HktApi.tierDomScore(el.textContent, apiPrice) }))
        .sort((a, b) => b.score - a.score)[0]?.el || null;
    }
    const byPrice = pool.find((c) => parsePrice(c.textContent) === apiPrice.price);
    if (byPrice) return byPrice;
    return pool.find((c) => (c.textContent || "").includes(String(apiPrice.price)));
  }

  async function applyApiGuidance(sessions, allCats, turbo = false) {
    const summary = turbo && lastApiSnapshot && Date.now() - lastApiPollAt < 2000
      ? lastApiSnapshot
      : await refreshApiStock(true);
    if (!summary) return false;

    if (summary.fullySoldOut) {
      stopAllSoldOut("Accelerator: ALL SOLD OUT on every date/tier");
      return true;
    }

    const offer = lastApiBestOffer || HktApi.pickBestOffer(summary, options);
    if (!offer) return false;

    const { event, price: apiPrice } = offer;
    log(
      `API pick · ${clipText(event.caption, 32)} · HK$${apiPrice.price} · stock ${apiPrice.goodCount}`,
      "info",
    );

    const selectedSession = sessions.find((s) => classHas(s, "fouceStyle___sel"));
    const hints = HktApi.sessionHintsFromEvent(event);
    const needsSession = sessions.length && (!selectedSession ||
      !hints.some((h) => selectedSession.textContent.includes(h)));

    if (needsSession) {
      const sessionEl = sessions.find(
        (s) => !isSessionSoldOut(s) && hints.some((h) => s.textContent.includes(h)),
      );
      if (sessionEl && clickEl(sessionEl)) {
        log(`Accel session → ${clipText(sessionEl.textContent, 55)}`);
        schedulePost(100);
        return true;
      }
    }

    const selectedTier = allCats.find(
      (c) => classHas(c, "reminderStyle___sel") || c.classList.contains("selected"),
    );
    if (!selectedTier || parsePrice(selectedTier.textContent) !== apiPrice.price) {
      const tierEl = findDomTierForApiPrice(allCats, apiPrice);
      if (tierEl && clickEl(tierEl)) {
        log(`Accel tier → HK$${apiPrice.price} ${clipText(apiPrice.name, 28)}`);
        schedulePost(90);
        return true;
      }
    }
    return false;
  }

  function pickSessionTarget(sessions) {
    const pick = pickAvailableSession(sessions);
    if (pick) return pick;
    log(`Session match not found (${sessionMatchCandidates().join(" | ")}) — using index`, "warn");
    const idx = Math.max(0, Math.min(sessions.length - 1, (options.sessionIndex || 1) - 1));
    return sessions[idx];
  }

  function matchesTierKeywords(el) {
    const keys = String(options.tierKeywords || "").split(/[,，|]/).map((s) => s.trim()).filter(Boolean);
    if (!keys.length) return true;
    const text = el.textContent || "";
    if (options.skipObstructed !== false && /restricted view|視線受阻|视线受阻|obstructed/i.test(text)) {
      return false;
    }
    return keys.some((k) => text.includes(k) || (k === "2099" && /2099/.test(text)));
  }

  function rankedTiers(cats) {
    const highFirst = options.preferHigherPrice !== false && (options.minPrice || 0) >= 2000;
    return cats
      .filter((c) => !c.disabled && !classHas(c, "disableClass___"))
      .filter((c) => matchesFilters(c))
      .filter((c) => matchesTierKeywords(c))
      .map((c) => {
        const zone = parseInt(c.dataset.zone || parseZone(c.textContent), 10);
        const price = parsePrice(c.textContent);
        return { el: c, zone: Number.isNaN(zone) ? 99 : zone, price: price || 0 };
      })
      .sort((a, b) => {
        if (highFirst && a.price !== b.price) return b.price - a.price;
        if (a.zone !== b.zone) return a.zone - b.zone;
        return a.price - b.price;
      });
  }

  async function setQuantity() {
    const stepper = queryOne(SEL.qtyStepper);
    if (!stepper || stepper.children.length < 3) return false;
    const countEl = stepper.children[1];
    const read = () => parseInt(countEl.textContent.trim(), 10);
    const want = Math.min(10, Math.max(1, options.quantity || 2));
    let cur = read();
    while (cur < want) {
      const plus = stepper.children[2] || stepper.querySelector('.plus, [class*="plus"]');
      if (!plus || !clickEl(plus)) break;
      await new Promise((r) => setTimeout(r, 100));
      const next = read();
      if (next === cur) break;
      cur = next;
    }
    return read() === want;
  }

  async function fillMemberFields() {
    let changed = false;
    const member = queryOne(SEL.memberField);
    if (member && options.memberNumber && !member.value.trim()) {
      member.value = options.memberNumber;
      member.dispatchEvent(new Event("input", { bubbles: true }));
      member.dispatchEvent(new Event("change", { bubbles: true }));
      changed = true;
      log(`Member filled: ${options.memberNumber}`);
    }
    const verify = queryOne(SEL.verifyField);
    const answer = options.presetAnswer || options.verificationAnswer;
    if (verify && answer && !verify.value.trim()) {
      verify.value = answer;
      verify.dispatchEvent(new Event("input", { bubbles: true }));
      verify.dispatchEvent(new Event("change", { bubbles: true }));
      changed = true;
      log("Verification answer filled");
    }
    return changed;
  }

  async function handleLogin() {
    if (!running) return;
    log("Log in manually on this page, then go to your event");
    schedule(1500);
  }

  async function handleEvent() {
    if (!running || yielded) return;
    await refreshApiStock();
    if (lastApiSnapshot) {
      if (lastApiSnapshot.fullySoldOut) {
        heartbeat(HktApi.formatStockLine(lastApiSnapshot));
      } else if (lastApiSnapshot.canAddCart) {
        heartbeat("API · canAddCart=true · watching Buy button");
      }
    }
    if (tabRole === "backup") {
      heartbeat("Backup tab idle on event page — primary tab handles Buy click");
      schedule(1200);
      return;
    }
    if (buyClickLocked && Date.now() - buyClickedAt < BUY_CLICK_COOLDOWN_MS) {
      schedule(800);
      return;
    }
    if (recoverFromError()) {
      schedule(300);
      return;
    }
    const purchaseBtn = findPurchaseButton();
    const buyBtn = findBuyButton();

    if (purchaseBtn && !buyBtn) {
      const label = normalizePurchaseText(purchaseBtn.textContent);
      if (label !== lastPurchaseLabel) {
        lastPurchaseLabel = label;
        log(`Purchase CTA: "${label}" — waiting (not clicking until Buy is enabled)`, "info");
      } else {
        const apiHint = lastApiSnapshot?.canAddCart ? " · API sale open" : "";
        heartbeat(`Armed · "${label}" · waiting for enabled Buy button${apiHint}`);
      }
      const waitMs = lastApiSnapshot?.canAddCart ? 180 : Math.max(options.interval || 500, 400);
      schedule(waitMs);
      return;
    }

    if (!buyBtn) {
      const apiHint = lastApiSnapshot?.canAddCart ? " · API sale open" : "";
      heartbeat(`Scanning event page — no enabled Buy button yet (${findBuyButtonCandidates().length} candidates)${apiHint}`);
      schedule(lastApiSnapshot?.canAddCart ? 180 : (options.interval || 500));
      return;
    }

    const label = normalizePurchaseText(buyBtn.textContent);
    if (clickEl(buyBtn)) {
      buyClickedAt = Date.now();
      buyClickLocked = true;
      if (buyObserver) buyObserver.disconnect();
      log(`Buy clicked: "${label}" — entering waiting room / queue`);
      lastPurchaseLabel = "";
      schedule(600);
      return;
    }
    schedule(500);
  }

  function isInHktQueue() {
    return /you are now in the queue|now in the queue|正在等候|排隊中|in the queue/i.test(pageText());
  }

  async function handleWaitingRoom() {
    if (!running || yielded) return;
    if (buyObserver) buyObserver.disconnect();
    buyClickLocked = true;

    await refreshApiStock(true);
    logApiStock();

    if (isInHktQueue()) {
      if (lastApiSnapshot?.fullySoldOut) {
        heartbeat("IN QUEUE · API: ALL SOLD OUT — inventory gone, hold or Quit");
      } else {
        heartbeat("IN QUEUE — do not refresh · auto-redirect when your turn");
      }
      schedule(350);
      if (/selectTicket/i.test(location.hash)) {
        log("Queue cleared — ticket page loading");
        schedule(200);
      }
      return;
    }

    const countdown = getWaitingRoomCountdown();
    const saleMs = parseHktSaleTimeMs();
    if (countdown) {
      heartbeat(`Waiting room · starts in ${countdown} · stay on this tab — no refresh`);
    } else if (saleMs != null) {
      heartbeat(`Waiting room · sale 12:00 HKT · ${formatCountdownMs(saleMs - Date.now())} left`);
    } else {
      heartbeat("Waiting room · stay on this tab until redirected at 12:00 HKT");
    }
    if (/selectTicket/i.test(location.hash)) {
      log("Waiting room cleared — ticket page loading");
      schedule(200);
      return;
    }
    if (/^busy\./i.test(location.hostname)) {
      log("Waiting room → queue (busy)");
      schedule(200);
      return;
    }
    schedule(900);
  }

  async function handleBusy() {
    if (!running || yielded) return;
    await refreshApiStock();
    if (lastApiSnapshot && retries % 8 === 0) logApiStock(true);
    if (lastApiSnapshot?.fullySoldOut) {
      heartbeat("Queue · API: ALL SOLD OUT");
    }
    if (recoverFromError()) {
      schedule(300);
      return;
    }
    if (queueStartedAt && (Date.now() - queueStartedAt) > QUEUE_TIMEOUT_MS) {
      log("Long queue hold — still polling (no refresh)", "warn");
      queueStartedAt = Date.now();
    }
    if (/selectTicket/i.test(location.hash) && !/^busy\./i.test(location.hostname)) {
      log("Queue cleared — post-queue accelerator active");
      retries = 0;
      tierPickOffset = 0;
      schedulePost(80);
      return;
    }
    const pos = getQueuePosition();
    if (pos !== null && pos !== lastQueuePos) {
      lastQueuePos = pos;
      log(`Queue position #${pos}${tabRole === "backup" ? " (backup tab)" : ""}`);
    }
    schedule(280);
  }

  async function tryRotateTier(ranked) {
    if (!options.rotateTiers || isFunction1() || !ranked.length) return false;
    tierPickOffset = (tierPickOffset + 1) % ranked.length;
    const pick = ranked[tierPickOffset];
    if (pick && clickEl(pick.el)) {
      log(`Rotated to tier ${tierPickOffset + 1}/${ranked.length}`, "warn");
      selectStuckRetries = 0;
      return true;
    }
    return false;
  }

  async function handleSelect() {
    if (!running || yielded) return;
    if (recoverFromError()) {
      schedule(300);
      return;
    }

    const sessions = queryAll(SEL.sessionItem);
    const allCats = queryAll(SEL.categoryItem);

    if (options.apiRadar !== false) {
      if (await applyApiGuidance(sessions, allCats, options.selectTurbo !== false)) return;
      if (!lastApiSnapshot || Date.now() - lastApiPollAt > 800) {
        await refreshApiStock();
      }
    }

    if (isGlobalSoldOutPage()) {
      stopAllSoldOut("All sessions and tiers are SOLD OUT");
      return;
    }

    if (sessions.length) {
      const selectedSession = sessions.find((s) => classHas(s, "fouceStyle___sel"));
      if (selectedSession && isSessionSoldOut(selectedSession)) {
        if (await tryNextSession(sessions)) return;
        if (allSessionsSoldOut(sessions)) {
          stopAllSoldOut("All show dates SOLD OUT");
          return;
        }
      }

      const hasSelected = sessions.some((s) => classHas(s, "fouceStyle___sel"));
      if (!hasSelected) {
        if (isFunction1()) {
          log("Function 1: pick session manually, then bot continues");
          schedule(options.interval || 500);
          return;
        }
        const target = pickAvailableSession(sessions);
        if (target && clickEl(target)) {
          log(`Session: ${clipText(target.textContent, 55)}`);
          schedulePost(120);
          return;
        }
        if (allSessionsSoldOut(sessions)) {
          stopAllSoldOut("All show dates SOLD OUT");
          return;
        }
      }
    }

    const enabled = queryAll(SEL.categoryEnabled);
    const tierPool = enabled.length ? enabled : allCats.filter((c) => !classHas(c, "disableClass___"));
    let ranked = rankedTiers(tierPool);

    if (!ranked.length && options.tierFallback !== false && enabled.length) {
      ranked = rankedTiersRelaxed(enabled);
      if (ranked.length) {
        log("Trying any available tier in price range (VIP may be gone)", "warn");
      }
    }

    if (tierPool.length !== lastTierCount) {
      if (tierPool.length > lastTierCount) {
        log(`Tiers unlocked: ${tierPool.length} available`, "info");
      }
      lastTierCount = tierPool.length;
    }

    const selectedCat = tierPool.find((c) => classHas(c, "reminderStyle___sel") || c.classList.contains("selected"));
    const selectedBad = selectedCat && (selectedCat.disabled || classHas(selectedCat, "disableClass___"));

    if (selectedBad && options.rotateTiers !== false && !isFunction1()) {
      log("Selected tier sold out — rotating", "warn");
      await tryRotateTier(ranked);
      schedule(200);
      return;
    }

    if (!selectedCat && ranked.length) {
      if (isFunction1()) {
        log("Function 1: pick tier manually, then bot retries");
        schedule(options.interval || 500);
        return;
      }
      const pick = ranked[tierPickOffset % ranked.length];
      if (pick && clickEl(pick.el)) {
        log(`Tier ${tierPickOffset % ranked.length + 1}/${ranked.length}: ${pick.el.textContent.trim().slice(0, 45)}`);
        schedulePost(100);
        return;
      }
    }

    if (!ranked.length) {
      if (recoverFromError()) {
        schedule(300);
        return;
      }
      if (allTiersSoldOut(allCats)) {
        if (sessions.length && await tryNextSession(sessions)) return;
        stopAllSoldOut("All tiers SOLD OUT — no inventory left");
        return;
      }
      heartbeat("Waiting for tiers / reassigned slots…");
      bumpRetry("tier wait");
      schedule(options.interval || 600);
      return;
    }

    const stepper = queryOne(SEL.qtyStepper);
    if (stepper) {
      const countEl = stepper.children[1];
      const cur = parseInt(countEl?.textContent?.trim() || "0", 10);
      const want = Math.min(10, Math.max(1, options.quantity || 2));
      if (cur < want) {
        await setQuantity();
        schedulePost(90);
        return;
      }
    }

    if (await handleCollectionMethod()) {
      schedulePost(100);
      return;
    }

    if (clickNext()) {
      log("Next clicked — selections locked, do not change date/tier/qty");
      retries = 0;
      selectStuckRetries = 0;
      schedulePost(150);
      return;
    }

    // HKT rule: changing tier after selection restarts checkout — retry Next only, never re-pick tier
    if (selectedCat) {
      heartbeat("Tier locked — retrying Next (do not change category per HKT rules)");
    }

    bumpRetry("select idle");
    schedule(options.interval || 500);
  }

  async function handleSeat() {
    if (!running) return;
    if (recoverFromError()) {
      schedule(300);
      return;
    }
    // HKT auto-assigns best available seats — no manual seat pick
    if (clickNext()) {
      log("Auto-assigned seats — Next clicked");
      retries = 0;
      schedulePost(120);
      return;
    }
    bumpRetry("seat idle");
    schedule(options.interval || 500);
  }

  async function handleConfirm() {
    if (!running || yielded) return;
    if (recoverFromError()) {
      schedule(300);
      return;
    }
    if (await handleCollectionMethod()) {
      schedulePost(100);
      return;
    }
    if (await fillMemberFields()) {
      schedulePost(100);
      return;
    }
    const agreeCheck = queryOne(SEL.agreement) || queryOne('input[type="checkbox"]');
    if (agreeCheck && options.autoConsent !== false && !agreeCheck.checked) {
      clickEl(agreeCheck);
      log("Agreement checked");
      schedulePost(100);
      return;
    }
    const allocateBtn = findButtonByLabels(ALLOCATE_LABELS);
    if (allocateBtn && clickEl(allocateBtn)) {
      log("Confirm order — pay within 5 minutes");
      retries = 0;
      schedulePost(120);
      return;
    }
    bumpRetry("confirm idle");
    schedule(options.interval || 500);
  }

  async function handlePayment() {
    if (!running) return;
    if (recoverFromError()) {
      schedule(300);
      return;
    }
    const externalPay = document.querySelector(
      'iframe[src*="payment"], iframe[src*="checkout"], iframe[src*="pay"], iframe[src*="secure"], iframe[src*="alipay"], iframe[src*="wechat"]',
    );
    if (externalPay) {
      log("Pay within 5 minutes or order cancels — complete checkout manually NOW", "warn");
      schedule(2000);
      return;
    }
    const payBtn = findPayButton();
    if (payBtn && clickEl(payBtn)) {
      log("Pay button clicked");
      schedule(1000);
      return;
    }
    bumpRetry("payment idle");
    schedule(options.interval || 500);
  }

  function isKktix() {
    return /kktix\.(com|cc)$/i.test(location.hostname);
  }

  async function processKktix(stage) {
    if (!running) return;
    if (stage !== "login" && recoverFromError()) {
      schedule(300);
      return;
    }
    const o = options;
    switch (stage) {
      case "login":
        return handleLogin();
      case "select": {
        const prices = queryAll(SEL.kktixPriceItem);
        if (prices.length) {
          const selected = prices.find((p) => p.classList.contains("selected"));
          if (!selected) {
            if (isFunction1()) {
              log("Function 1: pick KKTIX price manually");
              schedule(o.interval || 500);
              return;
            }
            const ranked = rankedTiers(prices);
            const pick = ranked[tierPickOffset % Math.max(1, ranked.length)];
            if (pick && clickEl(pick.el)) {
              log(`KKTIX price tier selected`);
              schedule(200);
              return;
            }
          }
        }
        const stepper = queryOne(SEL.qtyStepper);
        if (stepper) {
          const countEl = stepper.children[1];
          const cur = parseInt(countEl?.textContent?.trim() || "0", 10);
          const want = Math.min(10, Math.max(1, o.quantity || 2));
          if (cur < want) {
            await setQuantity();
            schedule(150);
            return;
          }
        }
        const terms = queryOne(SEL.kktixTerms);
        if (terms && o.autoConsent !== false && !terms.checked) {
          clickEl(terms);
          log("KKTIX terms agreed");
          schedule(200);
          return;
        }
        if (clickNext()) {
          log("KKTIX next");
          schedule(400);
          return;
        }
        bumpRetry("kktix select");
        schedule(o.interval || 500);
        return;
      }
      case "form":
      case "confirm": {
        if (await fillMemberFields()) {
          schedule(200);
          return;
        }
        if (clickNext()) {
          log("KKTIX form next");
          schedule(400);
          return;
        }
        bumpRetry("kktix form");
        schedule(o.interval || 500);
        return;
      }
      case "pay":
        return handlePayment();
      default:
        schedule(1000);
    }
  }

  async function processHkt(stage) {
    if (!running) return;
    switch (stage) {
      case "login": return handleLogin();
      case "event": return handleEvent();
      case "waitingRoom": return handleWaitingRoom();
      case "busy": return handleBusy();
      case "select": return handleSelect();
      case "seat": return handleSeat();
      case "confirm": return handleConfirm();
      case "pay": return handlePayment();
      case "complete":
        log("Order flow reached complete — check My Tickets", "info");
        stop();
        return;
      case "unknown":
        if (recoverFromError()) {
          schedule(300);
          return;
        }
        heartbeat(`Watching page · stage=unknown · open event detail if not there yet`);
        schedule(1000);
        return;
      default:
        schedule(1000);
    }
  }

  async function tick() {
    if (!running || yielded) return;
    const stage = detectCurrentStage();
    if (stage !== lastStage) {
      log(`Stage: ${stage}${tabRole === "backup" ? " · backup tab" : ""}`);
      notifyStageChange(stage);
      lastStage = stage;
      retryStage = "";
      retries = 0;
      selectStuckRetries = 0;
      if (stage === "select") tierPickOffset = 0;
      if (stage === "busy" || stage === "waitingRoom") watchQueueAdvance();
      if (stage === "waitingRoom" || stage === "busy" || stage === "select") {
        buyClickLocked = true;
        if (buyObserver) buyObserver.disconnect();
      }
      logStageDiagnostics("stage-change", true);
    } else if (running) {
      logStageDiagnostics("heartbeat");
    }
    if (isKktix()) await processKktix(stage);
    else await processHkt(stage);
  }

  function detectCurrentStage() {
    const host = location.hostname;
    const hash = location.hash || "";
    const path = location.pathname || "";

    if (/kktix\.(com|cc)$/i.test(host)) {
      if (/\/registrations\//i.test(path)) return "select";
      if (/confirm/i.test(path)) return "confirm";
      if (/payment|checkout/i.test(path)) return "pay";
      if (/complete/i.test(path)) return "complete";
      if (/login/i.test(path)) return "login";
      return "unknown";
    }

    if (/^busy\./i.test(host)) return "busy";
    if (/premier\.hkticketing\.com$/i.test(host)) return "legacy";
    if (/\/login/i.test(path) || /#\/login/i.test(hash)) return "login";
    if (/waitingRoom/i.test(hash)) return "waitingRoom";
    if (/selectTicket/i.test(hash)) return "select";
    if (/seatMap|chooseSeat|seatAllocation/i.test(hash)) return "seat";
    if (/confirmOrder|orderConfirm/i.test(hash)) return "confirm";
    if (/payment|checkout/i.test(hash)) return "pay";
    if (/complete/i.test(hash)) return "complete";
    if (/#\/allEvents/i.test(hash) || /\/allEvents/i.test(path)) return "event";
    return "unknown";
  }

  function collectSignals() {
    return {
      stage: lastStage,
      queuePosition: getQueuePosition(),
      sessionSelected: queryAll(SEL.sessionItem).some((s) => classHas(s, "fouceStyle___sel")),
      categorySelected: queryAll(SEL.categoryItem).some((c) => classHas(c, "reminderStyle___sel")),
      tiersVisible: queryAll(SEL.categoryEnabled).length,
      nextVisible: Boolean(findButtonByLabels(NEXT_LABELS)),
    };
  }

  async function start(opts) {
    if (running) return;
    options = {
      interval: 500,
      maxRetries: 200,
      quantity: 1,
      sessionIndex: 1,
      sessionMatch: "",
      zoneRange: "1-3",
      minPrice: 0,
      maxPrice: 100000,
      memberNumber: "",
      presetAnswer: "",
      function1Enabled: false,
      function2Enabled: true,
      skipObstructed: true,
      skipWheelchair: true,
      autoConsent: true,
      rotateTiers: false,
      diagnostics: true,
      dualTab: true,
      notifyOnSelect: true,
      soundAlert: true,
      antiBlock: true,
      autoCollection: true,
      collectionMethod: "qr",
      rotateSessions: true,
      tierFallback: true,
      apiRadar: true,
      apiPollMs: 1500,
      apiPollMsQueue: 900,
      apiPollMsSelect: 600,
      selectTurbo: true,
      apiStopInQueue: true,
      locale: detectPageLocale(),
      ...opts,
    };
    tabRole = options.tabRole || "primary";
    yielded = false;
    alertedStages = new Set();
    buyClickedAt = 0;
    buyClickLocked = false;
    sessionRotateOffset = 0;
    soldOutStopLogged = false;
    lastApiSnapshot = null;
    lastApiPollAt = 0;
    lastApiLogLine = "";
    lastApiCanAddCart = false;
    lastApiBestOffer = null;
    apiSoldOutQueueTicks = 0;
    applyEventPatchSelectors();
    running = true;
    retries = 0;
    retryStage = "";
    lastStage = "";
    tierPickOffset = 0;
    selectStuckRetries = 0;
    lastTierCount = 0;
    lastDiagAt = 0;
    lastDiagStage = "";
    lastQueuePos = null;
    queueStartedAt = Date.now();

    lastHeartbeatAt = 0;
    const locale = detectPageLocale();
    log(`LiveAuto armed — ${isFunction1() ? "Function 1" : "Function 2"} · ${locale.toUpperCase()} · ${tabRole} tab`);
    if (options.dualTab !== false && tabRole === "backup") {
      log("Backup tab armed — dual queue routing active", "info");
    }
    if (options.antiBlock !== false) log("Anti-block pacing ON (jittered intervals)", "info");
    if (options.apiRadar !== false) {
      log("Stock radar ON — read-only imaitix inventory while in queue", "info");
    }
    if (options.selectTurbo !== false) {
      log("Post-queue accelerator ON — turbo select/confirm after redirect", "info");
    }
    if (options.diagnostics !== false) {
      log("Stage diagnostics ON — verbose DOM logs on queue/select/pay", "info");
    }
    watchPurchaseButton();
    logScanReport();

    reportInterval = setInterval(() => {
      if (running) {
        chrome.runtime.sendMessage({
          type: "TICKPILOT_LIVE_AUTO_STATUS",
          running: true,
          stage: lastStage,
          signals: collectSignals(),
        }).catch(() => {});
      }
    }, 5000);

    schedule(300);
  }

  async function stop() {
    if (!running && !yielded) return;
    running = false;
    yielded = false;
    clearTimeout(timer);
    clearInterval(reportInterval);
    disconnectObservers();
    lastApiSnapshot = null;
    lastApiPollAt = 0;
    lastApiLogLine = "";
    lastApiCanAddCart = false;
    lastApiBestOffer = null;
    apiSoldOutQueueTicks = 0;
    log("LiveAuto stopped");
    chrome.runtime.sendMessage({
      type: "TICKPILOT_LIVE_AUTO_STATUS",
      running: false,
      stage: lastStage,
    }).catch(() => {});
  }

  function isRunning() {
    return running;
  }

  function isLiveTicketHost() {
    const host = location.hostname.replace(/^www\./, "");
    return /hkticketing\.com$/i.test(host)
      || /hkticketing\.com\.hk$/i.test(host)
      || /kktix\.(com|cc)$/i.test(host)
      || /cityline\.com$/i.test(host)
      || /urbtix\.hk$/i.test(host);
  }

  async function maybeAutoStart() {
    if (!isLiveTicketHost()) return;
    try {
      const data = await chrome.storage.local.get(["tickpilot"]);
      const opts = data.tickpilot?.options;
      if (!opts?.autoStart || running) return;
      const f1 = Boolean(opts.function1Enabled);
      const f2 = opts.function2Enabled !== false;
      if (!f1 && !f2) return;
      start({
        ...opts,
        function1Enabled: f1 && !f2,
        function2Enabled: f2,
      });
    } catch (_e) {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.type) return;
    if (msg.type === "LIVE_AUTO_START") {
      start(msg.options || {});
      sendResponse?.({ ok: true });
    } else if (msg.type === "LIVE_AUTO_STOP" || msg.type === "LIVE_AUTO_YIELD") {
      if (msg.type === "LIVE_AUTO_YIELD") {
        yielded = true;
        log(`Yielding — ${msg.reason || "other tab advanced"}`, "warn");
      }
      stop();
      sendResponse?.({ ok: true });
    } else if (msg.type === "LIVE_AUTO_SCAN") {
      (async () => {
        if (msg.options) options = { ...options, ...msg.options };
        if (options.apiRadar !== false) {
          await refreshApiStock(true);
          logApiStock(true);
        }
        const report = logScanReport();
        const diagnostics = options.diagnostics !== false ? collectStageDiagnostics() : null;
        sendResponse?.({ ok: true, report, diagnostics });
      })();
    }
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.tickpilot || running) return;
    const opts = changes.tickpilot.newValue?.options;
    if (opts?.autoStart && (opts.function1Enabled || opts.function2Enabled)) maybeAutoStart();
  });

  setTimeout(maybeAutoStart, 800);

  return {
    start,
    stop,
    isRunning,
    tick,
    scanPage,
    logScanReport,
    collectSignals,
    collectStageDiagnostics,
    logStageDiagnostics,
    detectCurrentStage,
    getApiStatusLine,
    getApiBestOfferLine,
    getHudMode,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.LiveAuto = LiveAuto;
}
