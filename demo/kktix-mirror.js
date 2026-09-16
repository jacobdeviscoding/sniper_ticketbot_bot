/** KKTIX mirror — TechTickBot-style flow */
const KKTIXMirror = (() => {
  const $app = () => document.getElementById("hkt-app");
  const prices = [
    { index: 1, name: "早鳥 General", price: 880, soldOut: false },
    { index: 2, name: "Standard", price: 1280, soldOut: false },
    { index: 3, name: "VIP", price: 2280, soldOut: true },
    { index: 4, name: "視線受阻 Obstructed", price: 680, soldOut: false, obstructed: true },
    { index: 5, name: "Wheelchair Companion", price: 680, soldOut: false, wheelchair: true },
  ];

  const state = {
    saleAt: 0,
    loggedIn: false,
    selectedPrice: null,
    qty: 1,
    termsChecked: false,
    countdownRefreshes: 0,
  };

  function detectStage() {
    const h = location.hash || "";
    if (/login/i.test(h)) return "login";
    if (/countdown/i.test(h)) return "countdown";
    if (/select/i.test(h)) return "select";
    if (/form/i.test(h)) return "form";
    if (/complete/i.test(h)) return "complete";
    return "event";
  }

  function isSaleOpen() {
    return Date.now() >= state.saleAt;
  }

  function navigate(hash) {
    location.hash = hash;
    render();
  }

  function reset(options) {
    state.saleAt = Date.now() + (options?.saleDelayMs || 12000);
    state.loggedIn = false;
    state.selectedPrice = null;
    state.qty = Math.min(10, Math.max(1, options?.quantity || 2));
    state.termsChecked = false;
    state.countdownRefreshes = 0;
    navigate("#/login");
  }

  function tryLogin() {
    state.loggedIn = true;
    navigate("#/countdown");
    return true;
  }

  function renderLogin() {
    $app().innerHTML = `
      <section class="hkt-card"><p class="hkt-kicker">KKTIX · 登入</p><h1>請先登入帳號</h1>
        <p class="hkt-copy">TechTickBot 要求：先登入 KKTIX，再用免費活動測試。</p>
        <button type="button" class="bui-btn-primary" id="kktix-login">Sign In</button>
      </section>`;
    $app().querySelector("#kktix-login").onclick = () => tryLogin();
  }

  function renderCountdown() {
    const remain = Math.max(0, Math.ceil((state.saleAt - Date.now()) / 1000));
    $app().innerHTML = `
      <section class="hkt-card"><p class="hkt-kicker">未開賣 · 倒數</p>
        <h1>開賣倒數 ${remain}s</h1>
        <p class="hkt-copy">若見到自動倒數刷新，代表 BOT 運作正常（mirror）。</p>
        <p id="refresh-count">Refreshes: ${state.countdownRefreshes}</p>
      </section>`;
    if (!isSaleOpen()) {
      setTimeout(() => {
        if (!isSaleOpen()) {
          if (window.__kktixAllowRefresh) state.countdownRefreshes += 1;
          render();
        } else {
          navigate("#/select");
        }
      }, 500);
    } else {
      navigate("#/select");
    }
  }

  function renderSelect() {
    const rows = prices.map((p) => {
      const sel = state.selectedPrice === p.index;
      const disabled = p.soldOut;
      return `<button type="button" class="levelItem___abc kktix-price ${disabled ? "disableClass___off" : ""} ${sel ? "reminderStyle___sel" : ""}"
        data-index="${p.index}" data-obs="${p.obstructed ? 1 : 0}" data-wc="${p.wheelchair ? 1 : 0}" ${disabled ? "disabled" : ""}>
        <strong>${p.index}. ${p.name}</strong><span>NT$ ${p.price}</span><em>${disabled ? "Sold out" : "Available"}</em>
      </button>`;
    }).join("");
    $app().innerHTML = `
      <section class="hkt-card ticketWrapRoot___abc"><p class="hkt-kicker">KKTIX · 選票</p><h1>選擇票種</h1>
        <div class="level-wrap">${rows}</div>
        <div class="buyNum___abc"><span class="minus">−</span><span class="count">${state.qty}</span><span class="plus">+</span></div>
        <label class="agree-row"><input id="kktix-terms" type="checkbox" ${state.termsChecked ? "checked" : ""} />
          <span>I have read and agree to the terms</span></label>
      </section>
      <div class="sellTicketBottomBtnWrap___abc"><button type="button" class="bui-btn-primary hkt-next" ${state.selectedPrice && state.termsChecked ? "" : "disabled"}>Next</button></div>`;
    bindSelect();
  }

  function bindSelect() {
    $app().querySelectorAll(".kktix-price").forEach((btn) => {
      btn.onclick = () => {
        if (btn.disabled) return;
        state.selectedPrice = state.selectedPrice === +btn.dataset.index ? null : +btn.dataset.index;
        render();
      };
    });
    const stepper = $app().querySelector(".buyNum___abc");
    stepper.querySelector(".minus").onclick = () => { state.qty = Math.max(1, state.qty - 1); render(); };
    stepper.querySelector(".plus").onclick = () => { state.qty = Math.min(10, state.qty + 1); render(); };
    $app().querySelector("#kktix-terms").onchange = (e) => { state.termsChecked = e.target.checked; render(); };
    $app().querySelector(".hkt-next").onclick = () => navigate("#/form");
  }

  function renderForm() {
    $app().innerHTML = `
      <section class="hkt-card"><p class="hkt-kicker">KKTIX · 表單</p><h1>購票資料</h1>
        <form class="login-form">
          <label>Member number <input id="kktix_member" name="member_number" value="" /></label>
          <label>Verification: 首都 of 香港? <input id="kktix_verify" name="verify" value="" /></label>
        </form>
      </section>
      <div class="sellTicketBottomBtnWrap___abc"><button type="button" class="bui-btn-primary hkt-next">Next</button></div>`;
    $app().querySelector(".hkt-next").onclick = () => navigate("#/complete");
  }

  function renderComplete() {
    const p = prices.find((x) => x.index === state.selectedPrice);
    $app().innerHTML = `
      <section class="hkt-card complete"><p class="stamp">TEST OK</p><h1>KKTIX mirror complete</h1>
        <dl class="summary">
          <div><dt>Price</dt><dd>${p?.name || "—"}</dd></div>
          <div><dt>Qty</dt><dd>${state.qty}</dd></div>
        </dl>
      </section>`;
    window.__HKT_TEST_RESULT__ = { ok: true, platform: "kktix", price: p?.name, qty: state.qty };
  }

  function render() {
    document.getElementById("mirror-hash").textContent = location.hash || "#/kktix";
    const stage = detectStage();
    if (stage === "login") return renderLogin();
    if (stage === "countdown") return renderCountdown();
    if (stage === "select") return renderSelect();
    if (stage === "form") return renderForm();
    if (stage === "complete") return renderComplete();
    return renderLogin();
  }

  const params = new URLSearchParams(location.search);
  if (window.__TP_PLATFORM__ === "kktix") {
    window.addEventListener("hashchange", render);
    if (!location.hash) navigate("#/login");
    else render();
    if (params.get("autotest") === "1") window.__HKT_AUTOTEST__ = true;
  }

  return { detectStage, reset, render, state, prices, isSaleOpen, navigate, tryLogin };
})();
