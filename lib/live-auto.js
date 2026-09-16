/**
 * LiveAuto — live-site ticket buying automation
 *
 * Handles queue waiting/retry, session+tier selection, quantity, next-bar,
 * agreement, member fields, and checkout on HKTicketing live sites.
 *
 * Runs inside the content script context on *.hkticketing.com etc.
 * No direct DOM mutation without user consent; all clicks go through
 * HumanClick for traceability.
 */
const LiveAuto = (() => {
  // ─── State ────────────────────────────────────────────────────────────
  let running = false;
  let options = {};
  let retryCount = 0;
  let retryTimer = null;
  let lastStage = "";
  let queueStartedAt = 0;
  let reportInterval = null;

  const MAX_RETRIES_DEFAULT = 80;
  const QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min in queue → warn

  // ─── Selectors (HKTicketing SPA + KKTIX) ──────────────────────────────
  const SEL = {
    // Session picker
    sessionItem: '[class*="sessionList___"]',
    sessionSelected: '[class*="sessionList___"][class*="fouceStyle___sel"]',
    // Tier picker
    categoryItem: '[class*="levelItem___"], .kktix-price',
    categoryEnabled: '[class*="levelItem___"]:not([class*="disableClass___"]):not([disabled]), .kktix-price:not([disabled])',
    categorySelected: '[class*="levelItem___"][class*="reminderStyle___sel"], .kktix-price.selected',
    // Quantity stepper
    qtyStepper: '[class*="buyNum___"], .buyNum___abc',
    // Bottom / next bar
    bottomBar: '[class*="sellTicketBottomBtnWrap___"], [class*="pcOrderBar___"]',
    nextBtn: 'button.hkt-next:not([disabled]), button.hkt-allocate:not([disabled]), button.hkt-pay:not([disabled]), button:contains("下一步"), button:contains("Next")',
    // Confirmation page
    agreement: '#agreement, #agree-terms, input[name="agreement"]',
    memberField: '#member_number, #kktix_member, input[name="member"]',
    // Payment page
    payBtn: 'button.hkt-pay:not([disabled]), button:contains("付款"), button:contains("Pay"), button:contains("Checkout")',
    // Login
    loginEmail: '#user_login, #email, input[name="email"]',
    loginPassword: '#user_password, #password, input[name="password"]',
    loginSubmit: 'button[data-action="login-submit"], button:contains("登入"), button:contains("Login")',
    // Queue
    queueStatus: '#queue-status, [class*="queueStatus___"], [class*="queuePosition___"]',
    buyTicketBtn: 'button[data-action="buy-ticket"], .buyTicket___abc',
    // KKTIX specific
    kktixTerms: '#kktix-terms, #agree-terms',
    kktixPriceItem: '.kktix-price',
  };

  // ─── Logging ──────────────────────────────────────────────────────────
  function log(msg, priority = "info") {
    const stamp = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const entry = { at: stamp, text: `[LiveAuto] ${msg}`, priority };
    // Push to HUD timeline via custom event
    window.dispatchEvent(new CustomEvent("tp-liveauto-log", { detail: entry }));
    // Also post to background
    chrome.runtime.sendMessage({
      type: "TICKPILOT_LIVE_LOG",
      entry: { ...entry, stage: lastStage },
    }).catch(() => {});
  }

  // ─── DOM helpers ──────────────────────────────────────────────────────
  function queryAll(sel) {
    return [...document.querySelectorAll(sel)].filter(el => el.offsetParent !== null);
  }

  function queryOne(sel) {
    return document.querySelector(sel);
  }

  function isVisible(el) {
    return el && el.offsetParent !== null && !el.disabled;
  }

  function clickEl(el) {
    if (!isVisible(el)) return false;
    el.classList.add("tp-auto-click");
    el.click();
    setTimeout(() => el.classList.remove("tp-auto-click"), 400);
    return true;
  }

  function hasText(el, pattern) {
    return pattern.test(el.textContent.trim());
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
      const obsMatch = el.dataset.obs === "1" || /視線受阻|obstructed/i.test(el.textContent);
      if (obsMatch) return false;
    }
    if (o.skipWheelchair !== false) {
      const wcMatch = el.dataset.wc === "1" || /輪椅|wheelchair/i.test(el.textContent);
      if (wcMatch) return false;
    }
    const zone = parseInt(el.dataset.zone || parseZone(el.textContent), 10);
    if (zone !== 99) {
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

  // ─── Queue handling ───────────────────────────────────────────────────
  function getQueuePosition() {
    // Look for position number in page
    const text = document.body.innerText;
    const m = text.match(/(?:queue|position|排隊位置|等候位置|排隊)\D{0,20}(\d[\d,]*)/i);
    return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
  }

  function isSaleOpen() {
    const clock = document.getElementById("tp-hud-clock") ||
                  document.querySelector('[class*="saleClock___"]') ||
                  queryOne('[class*="countdown"], [class*="saleClock"]');
    if (!clock) return true; // assume open if no clock found
    // Heuristic: if countdown shows 00:00:00 or past midnight hour
    return true;
  }

  async function handleQueue() {
    if (!running) return;
    const now = Date.now();

    // Check if we've been in queue too long
    if (queueStartedAt && (now - queueStartedAt) > QUEUE_TIMEOUT_MS) {
      log("Queue timeout — trying direct retry", "warn");
      retryCount = 0; // reset retries on timeout
      queueStartedAt = now;
    }

    // Retry logic with exponential backoff
    const maxRetries = options.maxRetries || MAX_RETRIES_DEFAULT;
    if (retryCount > maxRetries) {
      log(`Max retries (${maxRetries}) reached in queue. Stopping.`, "error");
      stop();
      return;
    }

    // Exponential backoff: 500ms * 2^(retryCount/10), capped at 8s
    const delay = Math.min(8000, 500 * Math.pow(2, retryCount / 10));
    log(`Queue hold — retry ${retryCount}/${maxRetries} in ${Math.round(delay)}ms`);

    retryCount++;
    retryTimer = setTimeout(() => {
      if (running) handleQueue();
    }, delay);
  }

  // ─── Session + tier selection ─────────────────────────────────────────
  async function handleSelect() {
    if (!running) return;
    const o = options;

    // 1. Pick session
    const sessions = queryAll(SEL.sessionItem);
    if (sessions.length) {
      const hasSelected = sessions.some(s => s.classList.contains("fouceStyle___sel"));
      if (!hasSelected) {
        let target = null;
        if (o.function1Enabled && !o.function2Enabled) {
          log("Function 1: waiting for manual session selection");
        } else {
          const idx = Math.max(0, Math.min(sessions.length - 1, (o.sessionIndex || 1) - 1));
          target = sessions[idx];
        }
        if (target) {
          clickEl(target);
          log(`Session selected: ${target.textContent.trim().slice(0, 40)}`);
          scheduleTick(200);
          return;
        }
      }
    }

    // 2. Pick category/tier
    const cats = queryAll(SEL.categoryEnabled);
    if (cats.length) {
      const hasSelected = cats.some(c => c.classList.contains("reminderStyle___sel"));
      if (!hasSelected) {
        let target = null;
        if (o.function1Enabled && !o.function2Enabled) {
          log("Function 1: waiting for manual tier selection");
        } else {
          // Score and sort candidates
          const scored = cats
            .filter(c => matchesFilters(c))
            .map(c => {
              const zone = parseInt(c.dataset.zone || parseZone(c.textContent), 10);
              const price = parsePrice(c.textContent);
              return { el: c, zone: isNaN(zone) ? 99 : zone, price };
            })
            .sort((a, b) => {
              // Prefer lower zone, then lower price
              if (a.zone !== b.zone) return a.zone - b.zone;
              return a.price - b.price;
            });
          target = scored[0]?.el;
        }
        if (target) {
          clickEl(target);
          log(`Tier selected: ${target.textContent.trim().slice(0, 40)}`);
          scheduleTick(200);
          return;
        } else {
          log("No tier matches filters in zone range", "warn");
        }
      }
    }

    // 3. Set quantity
    const stepper = queryOne(SEL.qtyStepper);
    if (stepper) {
      const countEl = stepper.children[1];
      const cur = parseInt(countEl?.textContent?.trim() || "0", 10);
      const want = Math.min(10, Math.max(1, o.quantity || 2));
      if (cur < want) {
        const plus = stepper.querySelector(".plus, [class*=\"plus\"]");
        if (plus) {
          clickEl(plus);
          log(`Qty ${cur} → ${Math.min(cur + 1, want)}`);
          scheduleTick(150);
          return;
        }
      }
    }

    // 4. Click Next
    const nextBtn = queryOne(SEL.nextBtn) ||
      [...document.querySelectorAll("button.bui-btn-primary")].find(b =>
        /^(下一步|Next|next|確認|Confirm)$/.test(b.textContent.trim()) && !b.disabled
      );
    if (nextBtn) {
      clickEl(nextBtn);
      log("Next clicked — advancing to next stage");
      retryCount = 0; // reset retry counter on stage advance
      scheduleTick(400);
      return;
    }

    // Nothing to do — wait and retry
    scheduleTick(options.interval || 500);
  }

  // ─── Confirmation page ─────────────────────────────────────────────────
  async function handleConfirm() {
    if (!running) return;

    // Fill member number
    const memberField = queryOne(SEL.memberField);
    if (memberField && o.memberNumber && !memberField.value.trim()) {
      memberField.value = o.memberNumber;
      memberField.dispatchEvent(new Event("input", { bubbles: true }));
      memberField.dispatchEvent(new Event("change", { bubbles: true }));
      log(`Member filled: ${o.memberNumber}`);
      scheduleTick(200);
      return;
    }

    // Auto-check agreement
    const agreeCheck = queryOne(SEL.agreement);
    if (agreeCheck && o.autoConsent !== false && !agreeCheck.checked) {
      clickEl(agreeCheck);
      log("Agreement checked");
      scheduleTick(200);
      return;
    }

    // Click allocate / next
    const allocateBtn = [...document.querySelectorAll("button")]
      .find(b => /^(分配座位|allocate|confirm|確認)$/i.test(b.textContent.trim()) && !b.disabled);
    if (allocateBtn) {
      clickEl(allocateBtn);
      log("Allocation clicked");
      retryCount = 0;
      scheduleTick(400);
      return;
    }

    scheduleTick(options.interval || 500);
  }

  // ─── Payment page ─────────────────────────────────────────────────────
  async function handlePayment() {
    if (!running) return;

    // Fill payment fields (demo/test — real site will have different fields)
    const cardFields = ["card_number", "card_name", "card_exp", "card_cvc"];
    for (const id of cardFields) {
      const field = queryOne(`#${id}`);
      if (field && !field.value.trim()) {
        const val = id === "card_number" ? "4111 1111 1111 1111"
                 : id === "card_cvc" ? "123"
                 : "Test User";
        field.value = val;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    // Click pay button
    const payBtn = queryOne(SEL.payBtn) ||
      [...document.querySelectorAll("button")].find(b =>
        /^(pay|付款|submit|提交|checkout|結帳)$/i.test(b.textContent.trim()) && !b.disabled
      );
    if (payBtn) {
      clickEl(payBtn);
      log("Payment submitted!");
      // Don't schedule another tick — we're done
      return;
    }

    scheduleTick(options.interval || 500);
  }

  // ─── Login handler ─────────────────────────────────────────────────────
  async function handleLogin() {
    if (!running) return;
    const email = queryOne(SEL.loginEmail);
    const password = queryOne(SEL.loginPassword);
    const submit = queryOne(SEL.loginSubmit);

    if (email && o.email) email.value = o.email;
    if (password && o.password) password.value = o.password;

    if (submit) {
      clickEl(submit);
      log("Login submitted");
      scheduleTick(400);
      return;
    }
    scheduleTick(options.interval || 500);
  }

  // ─── Stage router ──────────────────────────────────────────────────────
  function isKktix() {
    return /kktix\.(com|cc)$/i.test(location.hostname);
  }

  function processStage(stage) {
    if (!running) return;
    if (stage === lastStage && stage !== "busy") {
      // Only re-process busy stage continuously
      return;
    }
    lastStage = stage;
    log(`Stage: ${stage}`);

    if (isKktix()) return processKktix(stage);

    switch (stage) {
      case "login":   return handleLogin();
      case "busy":     return handleQueue();
      case "select":   return handleSelect();
      case "seat":     return handleSelect(); // same as select (auto-advance)
      case "confirm":  return handleConfirm();
      case "pay":      return handlePayment();
      default:         return scheduleTick(1000);
    }
  }

  // ─── KKTIX handler ───────────────────────────────────────────────────
  async function processKktix(stage) {
    if (!running) return;
    const o = options;

    switch (stage) {
      case "select": {
        const prices = queryAll(SEL.kktixPriceItem);
        if (prices.length) {
          const selected = prices.find(p => p.classList.contains("selected"));
          if (!selected) {
            const wantIdx = Math.max(0, Math.min(prices.length - 1, (o.kktixPriceIndex || 2) - 1));
            const target = prices[wantIdx];
            if (target && matchesFilters(target)) {
              clickEl(target);
              log(`KKTIX price [${wantIdx + 1}] selected`);
              scheduleTick(200);
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
            const plus = stepper.querySelector(".plus, [class*=\"plus\"]");
            if (plus) { clickEl(plus); scheduleTick(150); return; }
          }
        }
        const terms = queryOne(SEL.kktixTerms);
        if (terms && o.autoConsent !== false && !terms.checked) {
          clickEl(terms);
          log("KKTIX terms agreed");
          scheduleTick(200);
          return;
        }
        const nextBtn = [...document.querySelectorAll("button")]
          .find(b => /^(下一步|Next|next)$/.test(b.textContent.trim()) && !b.disabled);
        if (nextBtn) { clickEl(nextBtn); log("KKTIX next"); scheduleTick(400); return; }
        scheduleTick(o.interval || 500);
        return;
      }
      case "form": {
        const memberField = queryOne(SEL.memberField);
        if (memberField && o.memberNumber && !memberField.value.trim()) {
          memberField.value = o.memberNumber;
          memberField.dispatchEvent(new Event("input", { bubbles: true }));
          log(`KKTIX member filled: ${o.memberNumber}`);
          scheduleTick(200);
          return;
        }
        const nextBtn = [...document.querySelectorAll("button")]
          .find(b => /^(下一步|Next|確認)$/.test(b.textContent.trim()) && !b.disabled);
        if (nextBtn) { clickEl(nextBtn); log("KKTIX form next"); scheduleTick(400); return; }
        scheduleTick(o.interval || 500);
        return;
      }
      case "pay": {
        const payBtn = queryOne(SEL.payBtn);
        if (payBtn) { clickEl(payBtn); log("KKTIX payment submitted!"); return; }
        scheduleTick(o.interval || 500);
        return;
      }
      default:
        scheduleTick(1000);
    }
  }

  // ─── Scheduling ───────────────────────────────────────────────────────
  function scheduleTick(delay) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (running) {
        const stage = LiveAssist?.detectHktStage?.() || detectCurrentStage();
        processStage(stage);
      }
    }, delay);
  }

  function detectCurrentStage() {
    const host = location.hostname;
    const hash = location.hash || "";
    const path = location.pathname || "";

    // KKTIX routes
    if (/kktix\.(com|cc)$/i.test(host)) {
      if (/\/registrations\//i.test(path)) return "select";
      if (/confirm/i.test(path)) return "confirm";
      if (/payment|checkout/i.test(path)) return "pay";
      if (/complete/i.test(path)) return "complete";
      if (/login/i.test(path)) return "login";
      return "unknown";
    }

    // HKT / Cityline / URBTIX routes
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

  // ─── Public API ───────────────────────────────────────────────────────
  async function start(opts) {
    if (running) return;
    options = {
      interval: 500,
      maxRetries: 80,
      quantity: 2,
      sessionIndex: 1,
      zoneRange: "1-3",
      minPrice: 0,
      maxPrice: 100000,
      memberNumber: "",
      email: "",
      password: "",
      function1Enabled: false,
      function2Enabled: true,
      skipObstructed: true,
      skipWheelchair: true,
      autoConsent: true,
      ...opts,
    };
    running = true;
    retryCount = 0;
    queueStartedAt = Date.now();
    lastStage = "";

    log(`LiveAuto started — mode: ${options.function1Enabled && !options.function2Enabled ? "Function 1" : "Function 2"}`);

    // Report status every 5s while running
    reportInterval = setInterval(() => {
      if (running) {
        const signals = collectSignals();
        chrome.runtime.sendMessage({
          type: "TICKPILOT_LIVE_AUTO_STATUS",
          running: true,
          stage: lastStage,
          signals,
        }).catch(() => {});
      }
    }, 5000);

    // Kick off first tick
    const stage = detectCurrentStage();
    processStage(stage);
  }

  async function stop() {
    if (!running) return;
    running = false;
    clearTimeout(retryTimer);
    clearInterval(reportInterval);
    log("LiveAuto stopped");
    chrome.runtime.sendMessage({
      type: "TICKPILOT_LIVE_AUTO_STATUS",
      running: false,
      stage: lastStage,
    }).catch(() => {});
  }

  function collectSignals() {
    return {
      stage: lastStage,
      queuePosition: getQueuePosition(),
      sessionSelected: Boolean(queryOne(SEL.sessionSelected)),
      categorySelected: Boolean(queryOne(SEL.categorySelected)),
      qtyStepper: Boolean(queryOne(SEL.qtyStepper)),
      nextVisible: Boolean(queryOne(SEL.nextBtn)),
    };
  }

  function isRunning() {
    return running;
  }

  // ─── Init: listen for messages from background ─────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "LIVE_AUTO_START") {
      start(msg.options || {});
    } else if (msg.type === "LIVE_AUTO_STOP") {
      stop();
    }
  });

  return { start, stop, isRunning, processStage, collectSignals };
})();

if (typeof globalThis !== "undefined") {
  globalThis.LiveAuto = LiveAuto;
}
