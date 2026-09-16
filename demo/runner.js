(function initMirrorRunner() {
  const { SEL, ACTION_LABELS, visible, $, $$, formatHKT } = HKTShared;
  const getEl = (id) => document.getElementById(id);
  const isKktix = () => window.__TP_PLATFORM__ === "kktix";
  const mirror = () => (isKktix() ? KKTIXMirror : HKTMirror);

  const steps = { login: "WAITING", queue: "WAITING", selection: "WAITING", form: "WAITING", complete: "WAITING" };
  const logs = [];
  let options = {};
  let running = false;
  let completed = false;
  let timer = null;
  let retries = 0;
  let retryStage = "";
  let lastCommand = 0;
  let runMode = "function2";

  function doneCount() {
    return Object.values(steps).filter((v) => v === "DONE").length;
  }

  function pushLog(line) {
    logs.unshift(`[${formatHKT()}] ${line}`);
    if (logs.length > 16) logs.pop();
  }

  function paintHud(message) {
    const phase = completed ? "READY" : running ? "RUNNING" : "STANDBY";
    getEl("hud-state").textContent = phase;
    getEl("hud-message").textContent = message;
    getEl("hud-start").disabled = running;
    getEl("hud-stop").disabled = !running;
    ["login", "queue", "selection", "form", "complete"].forEach((name) => {
      const node = document.querySelector(`#hud-steps [data-step="${name}"]`);
      if (!node) return;
      node.classList.toggle("active", steps[name] === "RUNNING");
      node.classList.toggle("done", steps[name] === "DONE");
    });
    if (window.TPSettings?.setBotBadge) window.TPSettings.setBotBadge(running);
  }

  function extensionApi() {
    return typeof chrome !== "undefined" && chrome.runtime && chrome.storage ? chrome : null;
  }

  async function publish(message, notify) {
    paintHud(message);
    const api = extensionApi();
    const m = mirror();
    const stage = m.detectStage();
    const payload = {
      running,
      completed,
      connected: true,
      platform: "arena",
      pageTitle: isKktix() ? "KKTIX Mirror" : "HKTicketing Mirror",
      message,
      completedSteps: doneCount(),
      steps: {
        queue: steps.login === "DONE" ? steps.queue : "WAITING",
        selection: steps.selection,
        form: steps.form,
        complete: steps.complete,
      },
      logs: [...logs],
      hkt: {
        stage,
        stageLabel: isKktix() ? stage : m.STAGE_LABELS[stage],
        hash: location.hash,
        host: isKktix() ? "kktix.com (mirror)" : (HKTMirror?.state?.currentHost || "hkt.hkticketing.com") + " (mirror)",
        sessions: $$(SEL.session).length,
        categories: $$(`${SEL.category}:not(${SEL.categoryDisabled})`).length,
        captcha: false,
        clockHKT: formatHKT(),
      },
    };
    if (api) {
      await api.runtime.sendMessage({ type: "TICKPILOT_RUNTIME", notify, runtime: payload });
    }
    if (completed) {
      window.__HKT_TEST_RESULT__ = { ok: true, platform: isKktix() ? "kktix" : "hkt", message, steps: { ...steps }, logs: [...logs] };
    }
  }

  function mark(step, status, message, notify) {
    const changed = steps[step] !== status;
    steps[step] = status;
    if (status === "DONE" || changed) pushLog(message);
    return publish(message, notify);
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch((err) => {
      pushLog(`Recovered: ${err.message}`);
      schedule(options.interval || 400);
    }), delay);
  }

  async function pulseClick(el) {
    if (!el || el.disabled) return false;
    el.classList.add("pulse");
    el.click();
    await new Promise((r) => setTimeout(r, 150));
    setTimeout(() => el.classList.remove("pulse"), 350);
    return true;
  }

  function clickNext() {
    const direct = document.querySelector(
      "button.hkt-next:not([disabled]), button.hkt-allocate:not([disabled]), button.hkt-pay:not([disabled])",
    );
    if (direct) return pulseClick(direct);
    const bar = $(SEL.bottomBar);
    const pools = [bar ? [...bar.querySelectorAll("button")] : [], [...document.querySelectorAll("button.bui-btn-primary")], [...document.querySelectorAll("button")]];
    for (const pool of pools) {
      for (const label of ACTION_LABELS) {
        const btn = pool.find((b) => !b.disabled && b.textContent.trim() === label);
        if (btn) return pulseClick(btn);
      }
    }
    return false;
  }

  function categoryPassesFilters(el) {
    if (options.skipObstructed !== false && el.dataset.obs === "1") return false;
    if (options.skipWheelchair !== false && el.dataset.wc === "1") return false;
    const zone = parseInt(el.dataset.zone || "0", 10);
    if (zone) {
      const range = parseZoneRange(options.zoneRange);
      if (zone < range.min || zone > range.max) return false;
    }
    return true;
  }

  async function doHktLogin() {
    const email = $(SEL.loginEmail);
    const password = $(SEL.loginPassword);
    const submit = $(SEL.loginSubmit);
    if (email && options.email) email.value = options.email;
    if (password && options.password) password.value = options.password || "demo-pass-123";
    if (submit) await pulseClick(submit);
    return HKTMirror.state.loggedIn;
  }

  async function pickSession() {
    const rows = $$(SEL.session);
    if (!rows.length) return null;
    if (runMode === "function1") {
      return rows.find((r) => r.className.includes("fouceStyle___sel")) || null;
    }
    if (HKTMirror.state.selectedSession) {
      return rows.find((r) => r.dataset.session === HKTMirror.state.selectedSession) || rows[0];
    }
    const idx = Math.max(1, options.sessionIndex || 1) - 1;
    const chosen = rows[idx] || rows[0];
    await pulseClick(chosen);
    return chosen;
  }

  async function pickCategory() {
    const items = $$(SEL.category);
    const min = options.minPrice ?? 0;
    const max = options.maxPrice ?? 100000;

    if (runMode === "function1") {
      const selected = items.find((it) => it.className.includes("reminderStyle___sel"));
      if (selected && !selected.disabled) return selected;
      return null;
    }

    if (HKTMirror.state.selectedCategory) {
      const selected = items.find((it) => it.dataset.category === HKTMirror.state.selectedCategory);
      if (selected && !selected.disabled) return selected;
    }

    const scored = items
      .filter((it) => !it.disabled && !it.className.includes("disableClass___") && categoryPassesFilters(it))
      .map((it) => {
        const m = it.textContent.match(/HK\$\s*([\d,]+)/);
        const zone = parseInt(it.dataset.zone || "99", 10);
        return { el: it, price: m ? parseFloat(m[1].replace(/,/g, "")) : NaN, zone };
      })
      .filter((r) => !Number.isNaN(r.price) && r.price >= min && r.price <= max)
      .sort((a, b) => a.zone - b.zone || a.price - b.price);

    if (!scored.length) return null;
    await pulseClick(scored[0].el);
    return scored[0].el;
  }

  async function setQuantity() {
    const stepper = $(SEL.qtyStepper);
    if (!stepper || stepper.children.length < 3) return false;
    const countEl = stepper.children[1];
    const read = () => parseInt(countEl.textContent.trim(), 10);
    const want = Math.min(10, Math.max(1, options.quantity || 2));
    let cur = read();
    while (cur < want) {
      await pulseClick(stepper.children[2]);
      await new Promise((r) => setTimeout(r, 100));
      const next = read();
      if (next === cur) break;
      cur = next;
    }
    return read() === want;
  }

  async function tickAgreement() {
    if (options.autoConsent === false) {
      const input = document.querySelector('input[type="checkbox"]');
      return Boolean(input?.checked);
    }
    const input = document.querySelector('input[type="checkbox"]');
    if (!input || input.checked) return Boolean(input?.checked);
    await pulseClick(input);
    return input.checked;
  }

  async function fillMemberFields() {
    let changed = false;
    const member = document.getElementById("member_number") || document.getElementById("kktix_member");
    if (member && options.memberNumber && !member.value.trim()) {
      member.value = options.memberNumber;
      member.dispatchEvent(new Event("input", { bubbles: true }));
      changed = true;
    }
    const verify = document.getElementById("kktix_verify");
    if (verify && (options.presetAnswer || options.verificationAnswer) && !verify.value.trim()) {
      verify.value = options.presetAnswer || options.verificationAnswer;
      verify.dispatchEvent(new Event("input", { bubbles: true }));
      changed = true;
    }
    return changed;
  }

  async function fillPayment() {
    const fields = ["card_number", "card_name", "card_exp", "card_cvc"];
    let changed = false;
    fields.forEach((id) => {
      const node = document.getElementById(id);
      if (node && !node.value.trim()) {
        node.value = id === "card_number" ? "4111 1111 1111 1111" : id === "card_cvc" ? "123" : "test";
        node.dispatchEvent(new Event("input", { bubbles: true }));
        changed = true;
      }
    });
    return !changed || HKTMirror.state.paymentFilled;
  }

  async function tickKktix() {
    const m = KKTIXMirror;
    let stage = m.detectStage();

    if (steps.login !== "DONE") {
      await mark("login", "RUNNING", "KKTIX login first.");
      if (stage === "login") {
        const btn = document.getElementById("kktix-login");
        if (btn) await pulseClick(btn);
        schedule(400);
        return;
      }
      if (m.state.loggedIn) await mark("login", "DONE", "Signed in.");
    }

    if (steps.queue !== "DONE") {
      await mark("queue", "RUNNING", "Countdown before sale.");
      window.__kktixAllowRefresh = Boolean(options.allowRefresh);
      if (stage === "countdown" && !m.isSaleOpen()) {
        schedule(400);
        return;
      }
      if (m.isSaleOpen() || stage === "select") {
        await mark("queue", "DONE", "Sale open — selecting tickets.");
        stage = m.detectStage();
      } else {
        schedule(400);
        return;
      }
    }

    if (stage === "select" && steps.selection !== "DONE") {
      await mark("selection", "RUNNING", "KKTIX price + qty + terms.");
      const wantIdx = Math.max(1, options.kktixPriceIndex || 2);
      if (!m.state.selectedPrice) {
        let target = document.querySelector(`.kktix-price[data-index="${wantIdx}"]:not([disabled])`);
        if (target && options.skipObstructed !== false && target.dataset.obs === "1") target = null;
        if (target && options.skipWheelchair !== false && target.dataset.wc === "1") target = null;
        if (!target && runMode === "function2") {
          target = [...document.querySelectorAll(".kktix-price:not([disabled])")].find((btn) => {
            if (options.skipObstructed !== false && btn.dataset.obs === "1") return false;
            if (options.skipWheelchair !== false && btn.dataset.wc === "1") return false;
            return true;
          });
        }
        if (target) {
          await pulseClick(target);
          schedule(300);
          return;
        }
        bumpRetry("kktix price");
        pushLog("Waiting for price tier…");
        schedule(options.interval || 400);
        return;
      }
      const terms = document.getElementById("kktix-terms");
      if (terms && options.autoConsent !== false && !terms.checked) {
        terms.checked = true;
        terms.dispatchEvent(new Event("change", { bubbles: true }));
        schedule(300);
        return;
      }
      const stepper = document.querySelector(".buyNum___abc");
      const want = Math.min(10, Math.max(1, options.quantity || 2));
      const cur = stepper ? parseInt(stepper.children[1].textContent.trim(), 10) : want;
      if (cur !== want) {
        await setQuantity();
        schedule(300);
        return;
      }
      const nextBtn = document.querySelector(".hkt-next:not([disabled])");
      if (nextBtn && await pulseClick(nextBtn)) {
        await mark("selection", "DONE", "Ticket selection complete.");
      }
      schedule(400);
      return;
    }

    stage = m.detectStage();
    if (stage === "form" && steps.form !== "DONE") {
      await mark("form", "RUNNING", "Member + verification answers.");
      await fillMemberFields();
      const nextBtn = document.querySelector(".hkt-next");
      if (nextBtn && await pulseClick(nextBtn)) {
        await mark("form", "DONE", "Form submitted.");
      }
      schedule(400);
      return;
    }

    stage = m.detectStage();
    if (stage === "complete" && steps.complete !== "DONE") {
      running = false;
      completed = true;
      await mark("complete", "DONE", "KKTIX mirror complete.", { title: "TickPilot Mirror", message: "KKTIX flow passed." });
    }
  }

  async function tickHkt() {
    let stage = HKTMirror.detectStage();

    if (steps.login !== "DONE") {
      await mark("login", "RUNNING", `Signing in before 00:00 HKT (${formatHKT()}).`);
      if (stage === "login") {
        if (await doHktLogin()) await mark("login", "DONE", "Signed in before sale window.");
        schedule(400);
        return;
      }
      if (HKTMirror.state.loggedIn) await mark("login", "DONE", "Already signed in.");
    }

    if (steps.queue !== "DONE") {
      await mark("queue", "RUNNING", `${getEl("sale-clock").textContent} — hold queue, no refresh.`);
      if (stage === "event") {
        await pulseClick(document.getElementById("join-queue"));
        schedule(400);
        return;
      }
      if ((stage === "busy" || stage === "event") && !HKTMirror.isSaleOpen()) {
        if (stage === "event") HKTMirror.enterQueue();
        schedule(HKTMirror.standbyDelay());
        return;
      }
      if (HKTMirror.isSaleOpen()) {
        const conn = HKTMirror.tryConnect();
        if (!conn.ok) {
          bumpRetry("queue connect");
          pushLog(`Try ${retries}: ${conn.reason}`);
          schedule(options.interval || 400);
          return;
        }
        await mark("queue", "DONE", "Queue cleared at 00:00 HKT.", { title: "TickPilot Mirror", message: "Connected after midnight HKT." });
        stage = HKTMirror.detectStage();
      } else {
        schedule(HKTMirror.standbyDelay());
        return;
      }
    }

    stage = HKTMirror.detectStage();

    if (stage === "select" && steps.selection !== "DONE") {
      await mark("selection", "RUNNING", `${runMode === "function1" ? "F1 retry" : "F2 auto"} — session, tier, qty.`);
      const sessions = $$(SEL.session);
      const hasSession = sessions.some((r) => r.className.includes("fouceStyle___sel"));
      if (!hasSession) {
        if (runMode === "function1") {
          pushLog("Function 1: pick session manually first.");
          schedule(options.interval || 400);
          return;
        }
        await pickSession();
        schedule(300);
        return;
      }
      const catSelected = $$(SEL.category).some((r) => r.className.includes("reminderStyle___sel"));
      if (!catSelected) {
        const cat = await pickCategory();
        if (!cat) {
          bumpRetry("tier wait");
          pushLog(runMode === "function1" ? "F1: waiting for your tier to unlock…" : "Waiting for tier in zone range…");
          schedule(options.interval || 400);
          return;
        }
        schedule(300);
        return;
      }
      const stepper = $(SEL.qtyStepper);
      const want = Math.min(10, Math.max(1, options.quantity || 2));
      const cur = stepper ? parseInt(stepper.children[1].textContent.trim(), 10) : want;
      if (cur !== want) {
        await setQuantity();
        schedule(300);
        return;
      }
      const nextBtn = document.querySelector("button.hkt-next:not([disabled])")
        || $$("button.bui-btn-primary").find((b) => /^(Next|下一步)$/.test(b.textContent.trim()) && !b.disabled);
      if (nextBtn && await pulseClick(nextBtn)) {
        await mark("selection", "DONE", "Ticket selection complete.");
        stage = HKTMirror.detectStage();
      }
      schedule(400);
      return;
    }

    stage = HKTMirror.detectStage();

    if (stage === "seat" && steps.selection === "DONE" && steps.form !== "DONE") {
      await mark("form", "RUNNING", "seatMap — Next.");
      await clickNext();
      stage = HKTMirror.detectStage();
      schedule(400);
      return;
    }

    stage = HKTMirror.detectStage();

    if (stage === "confirm" && steps.form !== "DONE") {
      await mark("form", "RUNNING", "confirmOrder — member, agreement, allocation.");
      await fillMemberFields();
      const agreement = document.getElementById("agreement");
      if (agreement && options.autoConsent !== false && !agreement.checked) {
        agreement.checked = true;
        agreement.dispatchEvent(new Event("change", { bubbles: true }));
        schedule(300);
        return;
      }
      if (agreement && !agreement.checked) {
        schedule(400);
        return;
      }
      const allocate = document.querySelector("button.hkt-allocate:not([disabled])");
      if (allocate && await pulseClick(allocate)) {
        await mark("form", "DONE", "Order confirmed.");
        stage = HKTMirror.detectStage();
      }
      schedule(400);
      return;
    }

    stage = HKTMirror.detectStage();

    if (stage === "pay" && steps.complete !== "DONE") {
      await mark("complete", "RUNNING", "payment — sandbox checkout.");
      await fillPayment();
      ["card_number", "card_name", "card_exp", "card_cvc"].forEach((id) => {
        const node = document.getElementById(id);
        if (node) node.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const payBtn = document.querySelector("button.hkt-pay:not([disabled])");
      if (payBtn && await pulseClick(payBtn)) {
        running = false;
        completed = true;
        await mark("complete", "DONE", "Sandbox payment complete.", { title: "TickPilot Mirror", message: "Full HKT flow passed." });
      } else {
        schedule(400);
      }
    }
  }

  function bumpRetry(reason) {
    const stage = HKTShared.detectStage();
    if (stage !== retryStage) {
      retryStage = stage;
      retries = 0;
    }
    retries += 1;
    if (retries > (options.maxRetries || 80)) {
      throw new Error(reason || "max retries");
    }
  }

  async function tick() {
    if (!running) return;
    try {
      if (isKktix()) await tickKktix();
      else await tickHkt();
    } catch (err) {
      running = false;
      window.__HKT_TEST_RESULT__ = { ok: false, reason: err.message, logs };
      await publish(`Stopped: ${err.message}`);
    }
  }

  async function start(nextOptions) {
    if (running) return;
    options = {
      ...TICKPILOT_DEFAULTS,
      email: "alex.chan@example.com",
      password: "demo-pass-123",
      maxRetries: 200,
      ...nextOptions,
    };
    runMode = options.function1Enabled && !options.function2Enabled ? "function1" : "function2";
    running = true;
    completed = false;
    retries = 0;
    retryStage = "";
    window.__HKT_TEST_RESULT__ = null;
    Object.keys(steps).forEach((k) => { steps[k] = "WAITING"; });
    mirror().reset(options);
    pushLog(`Autotest armed — ${isKktix() ? "KKTIX" : "HKT"} · ${runMode}.`);
    await publish(`${runMode === "function1" ? "Function 1" : "Function 2"} started.`);
    schedule(500);
  }

  async function stop() {
    running = false;
    clearTimeout(timer);
    if (window.TPSettings?.setBotBadge) window.TPSettings.setBotBadge(false);
    await publish("Workflow stopped.");
  }

  async function hydrate() {
    const api = extensionApi();
    if (!api) {
      paintHud("Standalone mirror — click Start test or add ?autotest=1");
      if (window.__HKT_AUTOTEST__) start({ saleDelayMs: 10000, function2Enabled: true });
      return;
    }
    const result = await api.runtime.sendMessage({ type: "TICKPILOT_GET" });
    if (!result?.ok) return;
    options = result.state.options;
    lastCommand = result.state.command?.at || 0;
    if (result.state.command?.mode) runMode = result.state.command.mode;
    if (window.TPSettings?.writeCard) window.TPSettings.writeCard(options);
    await publish(`Mirror ready · ${formatHKT()}`);
    if (result.state.command?.type === "start" && Date.now() - result.state.command.at < 8000) {
      start({ ...result.state.options, function1Enabled: result.state.command.mode === "function1", function2Enabled: result.state.command.mode !== "function1" });
    } else if (window.__HKT_AUTOTEST__) {
      start({ ...result.state.options, saleDelayMs: 10000, function2Enabled: true });
    }
  }

  getEl("hud-start").addEventListener("click", async () => {
    const api = extensionApi();
    const result = api ? await api.runtime.sendMessage({ type: "TICKPILOT_GET" }) : null;
    start(result?.state?.options);
  });
  getEl("hud-stop").addEventListener("click", stop);

  const api = extensionApi();
  if (api) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.tickpilot) return;
      const command = changes.tickpilot.newValue?.command;
      if (command && command.at !== lastCommand) {
        lastCommand = command.at;
        if (command.type === "start") {
          start({
            ...changes.tickpilot.newValue.options,
            function1Enabled: command.mode === "function1",
            function2Enabled: command.mode !== "function1",
          });
        }
        if (command.type === "stop") stop();
      }
      if (window.TPSettings?.writeCard) window.TPSettings.writeCard(changes.tickpilot.newValue?.options);
    });
  }

  window.HKTRunner = { start, stop, tick, steps, logs: () => logs };
  hydrate();
})();
