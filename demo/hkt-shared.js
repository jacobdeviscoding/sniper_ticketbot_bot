const HKTShared = (() => {
  const TZ = "Asia/Hong_Kong";

  const HOSTS = {
    main: "hkt.hkticketing.com",
    busy: "busy.hkticketing.com",
  };

  const STAGE_LABELS = {
    login: "Login",
    busy: "Virtual queue",
    select: "Ticket selection",
    seat: "Seat map / allocation",
    confirm: "Order review",
    pay: "Payment",
    event: "Event listing",
    complete: "Test complete",
    unknown: "Unknown page",
  };

  const SEL = {
    session: '[class*="sessionList___"]',
    sessionSelected: '[class*="sessionList___"][class*="fouceStyle___"]',
    category: '[class*="levelItem___"]',
    categoryDisabled: '[class*="levelItem___"][class*="disableClass___"]',
    bottomBar: '[class*="sellTicketBottomBtnWrap___"], [class*="pcOrderBar___"]',
    qtyStepper: '[class*="buyNum___"]',
    seatMap: '[class*="seatMapCanvas___"]',
    loginEmail: "#user_login, #login_email, input[type='email'][name*='login'], input[type='email']",
    loginPassword: "#user_password, #login_password, input[type='password']",
    loginSubmit: "[data-action='login-submit'], button[type='submit']",
    buyButton: "#join-queue, [data-action='buy-ticket'], button.buyTicket___abc",
    connectionRetry: "[data-action='connection-retry'], .hkt-conn-retry",
  };

  const ACTION_LABELS = [
    "Next", "下一步", "Confirm", "確認", "确认", "Continue", "繼續",
    "Go to Payment", "前往付款", "Seat allocation", "分配座位", "Order", "下單",
    "Complete test payment", "立即購票", "登入",
  ];

  const AGREEMENT_RE = /I have read and agreed|我已閱讀並同意|我已阅读并同意/i;

  function nowHKTParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || "00";
    return { hour: get("hour"), minute: get("minute"), second: get("second") };
  }

  function formatHKT(date = new Date()) {
    const p = nowHKTParts(date);
    return `${p.hour}:${p.minute}:${p.second} HKT`;
  }

  function detectStage() {
    const hash = location.hash || "";
    if (/^#\/login/i.test(hash)) return "login";
    if (/^#\/queue/i.test(hash) || document.body.dataset.hktBusy === "true") return "busy";
    if (/selectTicket/i.test(hash)) return "select";
    if (/seatMap|chooseSeat|seatAllocation/i.test(hash)) return "seat";
    if (/confirmOrder|orderConfirm/i.test(hash)) return "confirm";
    if (/payment|checkout/i.test(hash)) return "pay";
    if (/complete/i.test(hash)) return "complete";
    if (/#\/allEvents/i.test(hash)) return "event";
    return "unknown";
  }

  function visible(el) {
    return Boolean(el && el.offsetParent !== null);
  }

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $$(selector, root = document) {
    return [...root.querySelectorAll(selector)].filter(visible);
  }

  function syncMirrorHost(host) {
    const node = document.getElementById("mirror-host");
    if (node) node.textContent = host;
    document.body.classList.toggle("hkt-on-busy", /^busy\./i.test(host));
    document.body.dataset.hktBusy = /^busy\./i.test(host) ? "true" : "false";
  }

  return {
    TZ,
    HOSTS,
    STAGE_LABELS,
    SEL,
    ACTION_LABELS,
    AGREEMENT_RE,
    formatHKT,
    nowHKTParts,
    detectStage,
    visible,
    $,
    $$,
    syncMirrorHost,
  };
})();
