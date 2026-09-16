const HKTMirror = (() => {
  const { SEL, HOSTS, detectStage, STAGE_LABELS, formatHKT, syncMirrorHost } = HKTShared;
  const $app = document.getElementById("hkt-app");
  const $hash = document.getElementById("mirror-hash");
  const $clock = document.getElementById("sale-clock");
  const ACTIVITY_ID = "demo-neon-2026";

  const state = {
    saleAt: 0,
    loggedIn: false,
    queueReleased: false,
    connectFails: 0,
    inventoryFlipped: false,
    selectedSession: null,
    selectedCategory: null,
    qty: 1,
    order: null,
    agreementChecked: false,
    paymentFilled: false,
    currentHost: HOSTS.main,
    queuePosition: 0,
    connectionError: null,
    tiersLoading: false,
  };

  const sessions = [
    { id: "s1", label: "2026年6月27日 (六) 20:00", match: "27 Jun", sub: "香港會議展覽中心" },
    { id: "s2", label: "2026年6月28日 (日) 19:30", match: "28 Jun", sub: "香港會議展覽中心" },
    { id: "s3", label: "2026年6月29日 (一) 20:00", match: "29 Jun", sub: "香港會議展覽中心" },
  ];

  const categories = [
    { id: "vip", zone: 1, name: "VIP / 企位", price: 1680, block: false, obstructed: false, wheelchair: false },
    { id: "std", zone: 2, name: "A / 標準", price: 880, block: false, obstructed: false, wheelchair: false },
    { id: "gen", zone: 3, name: "B / 普通", price: 480, block: false, obstructed: false, wheelchair: false },
    { id: "obs", zone: 3, name: "視線受阻", price: 380, block: false, obstructed: true, wheelchair: false },
    { id: "wc", zone: 4, name: "輪椅陪同", price: 480, block: true, obstructed: false, wheelchair: true },
  ];

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function setHost(host) {
    state.currentHost = host;
    syncMirrorHost(host);
  }

  function saleCountdownLabel() {
    const remain = state.saleAt - Date.now();
    if (remain > 0) {
      const sec = Math.max(0, Math.ceil(remain / 1000));
      return `HKT 23:59:${pad(sec)} · 開售倒數 ${sec}s`;
    }
    const elapsed = Math.floor((Date.now() - state.saleAt) / 1000);
    return `HKT 00:${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)} · 已開售`;
  }

  function isSaleOpen() {
    return Date.now() >= state.saleAt;
  }

  function navigate(hash) {
    location.hash = hash;
    render();
  }

  function categoryEnabled(cat) {
    if (cat.block) return false;
    if (!isSaleOpen() || !state.inventoryFlipped) return false;
    if (cat.id === "vip" || cat.id === "std") return true;
    if (cat.id === "gen" || cat.id === "obs") return state.connectFails >= 2;
    return false;
  }

  function queuePositionLabel() {
    if (state.queueReleased) return "已進入購票頁面";
    if (!isSaleOpen()) return `等候開售 · 預估位置 #${state.queuePosition || "—"}`;
    return `連線中 · 嘗試 ${state.connectFails + 1}`;
  }

  function reset(options) {
    state.saleAt = Date.now() + (options?.saleDelayMs || 12000);
    state.loggedIn = false;
    state.queueReleased = false;
    state.connectFails = 0;
    state.inventoryFlipped = false;
    state.selectedSession = null;
    state.selectedCategory = null;
    state.qty = Math.min(8, Math.max(1, options?.quantity || 2));
    state.order = null;
    state.agreementChecked = false;
    state.paymentFilled = false;
    state.queuePosition = Math.floor(Math.random() * 4000) + 800;
    state.connectionError = null;
    state.tiersLoading = false;
    setHost(HOSTS.main);
    navigate("#/login");
  }

  function tryLogin(email, password) {
    if (state.loggedIn) return { ok: true, reason: "Already signed in." };
    if (!email || !password) return { ok: false, reason: "Missing credentials." };
    state.loggedIn = true;
    document.body.dataset.hktLoggedIn = "true";
    setHost(HOSTS.main);
    navigate(`#/allEvents/detail?activityId=${ACTIVITY_ID}`);
    return { ok: true };
  }

  function enterQueue() {
    if (!state.loggedIn) return { ok: false, reason: "Login required before queue." };
    setHost(HOSTS.busy);
    navigate("#/queue");
    return { ok: true };
  }

  function tryConnect() {
    if (!state.loggedIn) return { ok: false, reason: "Not logged in." };
    if (!isSaleOpen()) return { ok: false, reason: "Sale window not open yet (HKT midnight)." };
    state.connectFails += 1;
    state.connectionError = null;
    if (state.connectFails <= 2) {
      const reason = state.connectFails === 1
        ? "連線失敗：伺服器繁忙，請重試"
        : "連線被拒：太多人同時購票";
      state.connectionError = reason;
      render();
      return { ok: false, reason };
    }
    state.queueReleased = true;
    state.tiersLoading = true;
    setHost(HOSTS.main);
    state.inventoryFlipped = true;
    navigate(`#/allEvents/detail/selectTicket?activityId=${ACTIVITY_ID}`);
    setTimeout(() => {
      state.tiersLoading = false;
      render();
    }, 600);
    return { ok: true };
  }

  function completeTestPayment() {
    if (!state.paymentFilled) return { ok: false, reason: "Payment form incomplete." };
    navigate("#/complete");
    return { ok: true };
  }

  function renderConnectionBanner() {
    if (!state.connectionError) return "";
    return `
      <div class="hkt-conn-banner" role="alert">
        <strong>連線錯誤</strong>
        <p>${state.connectionError}</p>
        <button type="button" class="bui-btn-primary hkt-conn-retry" data-action="connection-retry">重試</button>
      </div>`;
  }

  function renderLogin() {
    $app.innerHTML = `
      <section class="hkt-card hkt-login-card">
        <p class="hkt-kicker">hkt.hkticketing.com · 登入</p>
        <h1>登入 HK Ticketing</h1>
        <p class="hkt-copy">開售前請先登入並保持登入狀態。開售時間：<strong>00:00 HKT</strong> · 現時 <strong>${formatHKT()}</strong></p>
        <form id="login-form" class="login-form">
          <label>電郵地址 <input id="user_login" name="user_login" type="email" value="alex.chan@example.com" autocomplete="username" /></label>
          <label>密碼 <input id="user_password" name="user_password" type="password" value="demo-pass-123" autocomplete="current-password" /></label>
          <label class="agree-row"><input id="remember_me" type="checkbox" checked /> <span>保持登入狀態</span></label>
          <button type="submit" class="bui-btn-primary" data-action="login-submit">登入</button>
        </form>
      </section>`;
    $app.querySelector("#login-form").addEventListener("submit", (e) => {
      e.preventDefault();
      tryLogin(
        $app.querySelector("#user_login").value.trim(),
        $app.querySelector("#user_password").value,
      );
    });
  }

  function renderEvent() {
    $app.innerHTML = `
      <section class="hkt-card hkt-event-card">
        <div class="event-hero">
          <div class="event-poster">NEON<br>CURRENT</div>
          <div>
            <p class="hkt-kicker">allEvents / detail</p>
            <h1>Neon Current 霓虹電流</h1>
            <p class="hkt-copy">venue · 香港會議展覽中心 · activityId=${ACTIVITY_ID}</p>
            <ul class="event-meta">
              <li><span>開售</span><strong>00:00 HKT</strong></li>
              <li><span>狀態</span><strong>${isSaleOpen() ? "已開售" : "未開售"}</strong></li>
              <li><span>語言</span><strong>繁體中文</strong></li>
            </ul>
          </div>
        </div>
        <p class="hkt-copy warn-inline">⚠ 開售後請勿刷新；排隊期間刷新會失去位置。</p>
        <button type="button" class="bui-btn-primary buyTicket___abc" id="join-queue" data-action="buy-ticket">立即購票</button>
      </section>`;
    $app.querySelector("#join-queue").addEventListener("click", () => enterQueue());
  }

  function renderQueue() {
    const progress = state.queueReleased ? 100 : !isSaleOpen() ? 35 : Math.min(90, 40 + state.connectFails * 18);
    $app.innerHTML = `
      <section class="hkt-card queue-card">
        <p class="hkt-kicker">busy.hkticketing.com · virtual waiting room</p>
        <h1>您正在虛擬等候室中</h1>
        <p class="hkt-copy">請稍候，即將為您安排購票。請勿關閉或刷新此頁面。</p>
        ${renderConnectionBanner()}
        <div class="queue-stats">
          <div><span>排隊位置</span><strong>#${state.queuePosition}</strong></div>
          <div><span>狀態</span><strong>${queuePositionLabel()}</strong></div>
          <div><span>時鐘</span><strong>${saleCountdownLabel()}</strong></div>
        </div>
        <div class="queue-meter"><i style="width:${progress}%"></i></div>
        <div class="queue-spinner" aria-hidden="true"></div>
        <p id="queue-status" class="queue-status">${!isSaleOpen() ? "等待 00:00 HKT 開售…" : state.queueReleased ? "已通過等候室" : "00:00 已過 · 正在連線至 selectTicket…"}</p>
      </section>`;
    $app.querySelector(".hkt-conn-retry")?.addEventListener("click", () => tryConnect());
  }

  function renderSelect() {
    const sessionRows = sessions.map((s) => {
      const selected = state.selectedSession === s.id;
      return `<button type="button" class="sessionList___abc ${selected ? "fouceStyle___sel" : ""}" data-session="${s.id}">
        <span><strong>${s.label}</strong><em>${s.sub}</em></span>
      </button>`;
    }).join("");

    const tierBlock = state.tiersLoading
      ? `<div class="tier-skeleton"><i></i><i></i><i></i><p>載入票價中…</p></div>`
      : categories.map((cat) => {
          const enabled = categoryEnabled(cat);
          const selected = state.selectedCategory === cat.id;
          return `<button type="button" class="levelItem___abc ${enabled ? "" : "disableClass___off"} ${selected ? "reminderStyle___sel" : ""}"
            data-category="${cat.id}" data-zone="${cat.zone}" data-obs="${cat.obstructed ? 1 : 0}" data-wc="${cat.wheelchair ? 1 : 0}" ${enabled ? "" : "disabled"}>
            <span><strong>${cat.name}</strong><em>Zone ${cat.zone}</em></span>
            <span>HK$ ${cat.price.toLocaleString()}</span>
            <em>${enabled ? "可售" : "暫未開放"}</em>
          </button>`;
        }).join("");

    $app.innerHTML = `
      <section class="hkt-card ticketWrapRoot___abc">
        <p class="hkt-kicker">hkt.hkticketing.com · selectTicket</p>
        <h1>選擇門票</h1>
        <h2 class="section-title">選擇場次</h2>
        <div class="session-wrap">${sessionRows}</div>
        <h2 class="section-title">選擇票價</h2>
        <div class="level-wrap">${tierBlock}</div>
        <h2 class="section-title">數量</h2>
        <div class="buyNum___abc"><span class="minus">−</span><span class="count">${state.qty}</span><span class="plus">+</span></div>
      </section>
      <div class="sellTicketBottomBtnWrap___abc pcOrderBar___abc">
        <div class="order-summary-mini">
          <span>${state.selectedCategory ? "已選票價" : "請選擇場次及票價"}</span>
          <strong>${state.selectedCategory ? `HK$ ${categories.find((c) => c.id === state.selectedCategory)?.price || "—"}` : "—"}</strong>
        </div>
        <button type="button" class="bui-btn-primary hkt-next" ${state.selectedSession && state.selectedCategory && !state.tiersLoading ? "" : "disabled"}>下一步</button>
      </div>`;

    bindSelectHandlers();
  }

  function bindSelectHandlers() {
    $app.querySelectorAll("[data-session]").forEach((btn) => {
      btn.addEventListener("click", () => { state.selectedSession = btn.dataset.session; render(); });
    });
    $app.querySelectorAll("[data-category]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        state.selectedCategory = state.selectedCategory === btn.dataset.category ? null : btn.dataset.category;
        render();
      });
    });
    const stepper = $app.querySelector(".buyNum___abc");
    if (stepper) {
      stepper.querySelector(".minus").addEventListener("click", () => { state.qty = Math.max(1, state.qty - 1); render(); });
      stepper.querySelector(".plus").addEventListener("click", () => { state.qty = Math.min(8, state.qty + 1); render(); });
    }
    $app.querySelector(".hkt-next")?.addEventListener("click", () => {
      if (!state.selectedSession || !state.selectedCategory) return;
      state.order = {
        session: sessions.find((s) => s.id === state.selectedSession),
        category: categories.find((c) => c.id === state.selectedCategory),
        qty: state.qty,
      };
      navigate(`#/allEvents/detail/seatMap?activityId=${ACTIVITY_ID}`);
    });
  }

  function renderSeat() {
    $app.innerHTML = `
      <section class="hkt-card">
        <p class="hkt-kicker">seatMap · chooseSeat</p>
        <h1>選擇座位</h1>
        <p class="hkt-copy">系統將自動分配座位，或可手動選擇（mirror）。</p>
        <div class="seatMapCanvas___abc">
          ${["A-12", "A-13", "A-14", "A-15", "B-01", "B-02", "B-03", "B-04"].map((id, i) =>
            `<div class="seat ${i === 2 || i === 5 ? "sold" : "open"}" data-seat="${id}">${id}</div>`).join("")}
        </div>
      </section>
      <div class="sellTicketBottomBtnWrap___abc pcOrderBar___abc">
        <button type="button" class="bui-btn-primary hkt-next">下一步</button>
      </div>`;
    $app.querySelector(".hkt-next").addEventListener("click", () =>
      navigate(`#/allEvents/detail/confirmOrder?activityId=${ACTIVITY_ID}`));
  }

  function renderConfirm() {
    const o = state.order;
    $app.innerHTML = `
      <section class="hkt-card">
        <p class="hkt-kicker">confirmOrder · orderConfirm</p>
        <h1>確認訂單</h1>
        <dl class="summary">
          <div><dt>場次</dt><dd>${o?.session?.label || "—"}</dd></div>
          <div><dt>票價</dt><dd>${o?.category?.name || "—"} · HK$ ${o?.category?.price?.toLocaleString() || "—"}</dd></div>
          <div><dt>數量</dt><dd>${o?.qty || "—"}</dd></div>
        </dl>
        <label class="field-block">會員號碼 <input id="member_number" name="member_number" value="" placeholder="選填" /></label>
        <label class="agree-row"><input id="agreement" type="checkbox" ${state.agreementChecked ? "checked" : ""} />
          <span>我已閱讀並同意條款及細則</span></label>
      </section>
      <div class="sellTicketBottomBtnWrap___abc pcOrderBar___abc">
        <button type="button" class="bui-btn-primary hkt-allocate" ${state.agreementChecked ? "" : "disabled"}>分配座位</button>
      </div>`;
    $app.querySelector("#agreement").addEventListener("change", (e) => { state.agreementChecked = e.target.checked; render(); });
    $app.querySelector(".hkt-allocate").addEventListener("click", () => {
      if (!state.agreementChecked) return;
      navigate(`#/allEvents/detail/payment?activityId=${ACTIVITY_ID}`);
    });
  }

  function renderPayment() {
    $app.innerHTML = `
      <section class="hkt-card">
        <p class="hkt-kicker">payment · checkout · sandbox</p>
        <h1>付款</h1>
        <p class="hkt-copy warn">Sandbox mirror — 測試卡，不會真實扣款。</p>
        <div class="pay-iframe-mock">
          <p>Secure payment iframe (simulated)</p>
          <form class="pay-form" id="pay-form">
            <label>卡號 <input id="card_number" type="text" value="4111 1111 1111 1111" autocomplete="cc-number" /></label>
            <label>持卡人 <input id="card_name" type="text" value="Alex Chan" autocomplete="cc-name" /></label>
            <label>有效期 <input id="card_exp" type="text" value="12/28" autocomplete="cc-exp" /></label>
            <label>CVC <input id="card_cvc" type="password" value="123" autocomplete="cc-csc" /></label>
          </form>
        </div>
      </section>
      <div class="sellTicketBottomBtnWrap___abc pcOrderBar___abc">
        <button type="button" class="bui-btn-primary hkt-pay" disabled>Complete test payment</button>
      </div>`;
    const form = $app.querySelector("#pay-form");
    const payBtn = $app.querySelector(".hkt-pay");
    const validate = () => {
      const ok = ["card_number", "card_name", "card_exp", "card_cvc"].every((id) => $app.querySelector(`#${id}`).value.trim());
      state.paymentFilled = ok;
      payBtn.disabled = !ok;
    };
    form.addEventListener("input", validate);
    validate();
    payBtn.addEventListener("click", () => completeTestPayment());
  }

  function renderComplete() {
    const o = state.order;
    $app.innerHTML = `
      <section class="hkt-card complete">
        <p class="stamp">TEST OK</p>
        <h1>Mirror 流程完成</h1>
        <p class="hkt-copy">登入 → busy 排隊 → selectTicket → seatMap → confirmOrder → payment · ${formatHKT()}</p>
        <dl class="summary">
          <div><dt>場次</dt><dd>${o?.session?.label || "—"}</dd></div>
          <div><dt>票價</dt><dd>${o?.category?.name || "—"}</dd></div>
          <div><dt>數量</dt><dd>${o?.qty || "—"}</dd></div>
        </dl>
      </section>`;
    window.__HKT_TEST_RESULT__ = {
      ok: true,
      stage: "complete",
      loggedIn: state.loggedIn,
      order: o,
      finishedAtHKT: formatHKT(),
      hosts: [HOSTS.main, HOSTS.busy],
    };
  }

  function render() {
    $hash.textContent = location.hash || "#/login";
    $clock.textContent = saleCountdownLabel();
    document.body.dataset.hktStage = detectStage();
    syncMirrorHost(state.currentHost);

    if (state.currentHost === HOSTS.busy && detectStage() !== "busy") {
      setHost(HOSTS.busy);
    }

    const stage = detectStage();
    if (stage === "login") return renderLogin();
    if (stage === "event") return renderEvent();
    if (stage === "busy") return renderQueue();
    if (stage === "select") return renderSelect();
    if (stage === "seat") return renderSeat();
    if (stage === "confirm") return renderConfirm();
    if (stage === "pay") return renderPayment();
    if (stage === "complete") return renderComplete();
    return renderEvent();
  }

  window.addEventListener("hashchange", render);
  setInterval(() => {
    $clock.textContent = saleCountdownLabel();
    if (detectStage() === "busy" && !state.queueReleased) {
      const el = document.getElementById("queue-status");
      if (el) el.textContent = !isSaleOpen() ? "等待 00:00 HKT 開售…" : "00:00 已過 · 正在連線至 selectTicket…";
    }
  }, 250);

  const params = new URLSearchParams(location.search);
  if (window.__TP_PLATFORM__ === "kktix") {
    return null;
  }
  if (!location.hash) navigate("#/login");
  else render();

  if (params.get("autotest") === "1") {
    window.__HKT_AUTOTEST__ = true;
  }

  return {
    SEL, STAGE_LABELS, HOSTS, detectStage, sessions, categories, state,
    formatHKT, isSaleOpen, tryLogin, enterQueue, tryConnect, completeTestPayment,
    reset, navigate, render, setHost,
    standbyDelay() {
      const remain = state.saleAt - Date.now();
      if (remain > 3000) return 800;
      if (remain > 600) return 200;
      if (remain > 0) return 40;
      return 400;
    },
  };
})();
