/** Live-site assist helpers — detect + alert only, no automation */
const LiveAssist = (() => {
  const STAGE_ACTIONS = {
    login: {
      zh: "請先登入並勾選「保持登入狀態」。",
      en: "Log in and enable stay-signed-in before sale time.",
      priority: "info",
    },
    event: {
      zh: "確認活動頁面，開售時點擊「立即購票」。",
      en: "On the event page — click buy when sale opens.",
      priority: "info",
    },
    busy: {
      zh: "您在等候室 — 請勿刷新或關閉此分頁。",
      en: "In virtual queue — do not refresh or close this tab.",
      priority: "warn",
    },
    select: {
      zh: "選票頁已開 — 手動選場次、票價、數量，再按「下一步」。",
      en: "Ticket selection open — pick session, tier, qty, then Next.",
      priority: "critical",
    },
    seat: {
      zh: "座位頁 — 選位或等待自動分配，然後按「下一步」。",
      en: "Seat map — choose seats or wait for allocation, then Next.",
      priority: "warn",
    },
    confirm: {
      zh: "確認訂單 — 填會員號碼、勾選條款，再按「分配座位」。",
      en: "Confirm order — member number, agree to terms, then allocate seats.",
      priority: "warn",
    },
    pay: {
      zh: "付款頁 — 請手動完成付款。",
      en: "Payment page — complete checkout manually.",
      priority: "critical",
    },
    legacy: {
      zh: "舊版網站 — 流程可能不同，請留意頁面提示。",
      en: "Legacy site detected — flow may differ.",
      priority: "info",
    },
    unknown: {
      zh: "未能識別頁面 — 請前往活動 selectTicket 頁面。",
      en: "Unknown page — navigate to the event selectTicket route.",
      priority: "info",
    },
  };

  const ALERT_LABELS = {
    stage_change: "Stage changed",
    select_open: "Select ticket open",
    tier_unlock: "Tier unlocked",
    captcha: "Captcha detected",
    host_busy: "Queue host active",
    action_ready: "Next bar visible",
    payment: "Payment page",
  };

  function actionFor(stage, locale = "zh-HK") {
    const row = STAGE_ACTIONS[stage] || STAGE_ACTIONS.unknown;
    return /zh/i.test(locale) ? row.zh : row.en;
  }

  function priorityFor(stage) {
    return (STAGE_ACTIONS[stage] || STAGE_ACTIONS.unknown).priority;
  }

  function stageProgress(stage) {
    const order = ["login", "event", "busy", "select", "seat", "confirm", "pay"];
    const idx = order.indexOf(stage);
    return idx >= 0 ? idx + 1 : 0;
  }

  function fingerprint(signals) {
    return [
      signals.stage,
      signals.host,
      signals.categories,
      signals.sessions,
      signals.captcha ? 1 : 0,
      signals.nextBar ? 1 : 0,
      signals.qtyStepper ? 1 : 0,
    ].join("|");
  }

  function diffAlerts(prev, next, options) {
    if (!options?.liveAssistEnabled) return [];
    const alerts = [];
    const push = (type, message, priority = "info") => {
      alerts.push({ type, message, priority, key: `${type}:${next.stage}:${next.host}:${next.categories}` });
    };

    if (prev.stage !== next.stage) {
      push("stage_change", `${ALERT_LABELS.stage_change}: ${next.stageLabel}`, priorityFor(next.stage));
      if (next.stage === "select") {
        push("select_open", ALERT_LABELS.select_open, "critical");
      }
      if (next.stage === "pay") {
        push("payment", ALERT_LABELS.payment, "critical");
      }
    }

    if (/^busy\./i.test(next.host) && !/^busy\./i.test(prev.host || "")) {
      push("host_busy", ALERT_LABELS.host_busy, "warn");
    }

    if (next.stage === "busy" && next.queuePosition && next.queuePosition !== prev.queuePosition) {
      push("queue_position", `Queue position: #${next.queuePosition}`, "info");
    }

    if (next.stage === "select" && next.categories > (prev.categories || 0)) {
      const delta = next.categories - (prev.categories || 0);
      push("tier_unlock", `${ALERT_LABELS.tier_unlock}: +${delta} (${next.categories} open)`, "critical");
    }

    if (next.captcha && !prev.captcha) {
      push("captcha", ALERT_LABELS.captcha, "critical");
    }

    if (next.nextBar && !prev.nextBar && next.stage === "select") {
      push("action_ready", ALERT_LABELS.action_ready, "warn");
    }

    return alerts.filter((a) => {
      if (a.type === "stage_change" && options.alertStageChange === false) return false;
      if (a.type === "tier_unlock" && options.alertTierUnlock === false) return false;
      if (a.type === "select_open" && options.alertSelectOpen === false) return false;
      if (a.type === "captcha" && options.alertCaptcha === false) return false;
      if (a.type === "host_busy" && options.alertQueue === false) return false;
      if (a.type === "payment" && options.alertPayment === false) return false;
      if (a.type === "action_ready" && options.alertActionReady === false) return false;
      return true;
    });
  }

  function nowHKTParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Hong_Kong",
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

  function msUntilNextMidnightHKT(date = new Date()) {
    const p = nowHKTParts(date);
    const elapsed = ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000;
    return 24 * 60 * 60 * 1000 - elapsed;
  }

  function saleCountdown(date = new Date()) {
    const remain = msUntilNextMidnightHKT(date);
    const totalSec = Math.max(0, Math.ceil(remain / 1000));
    const hour = Math.floor(totalSec / 3600);
    const minute = Math.floor((totalSec % 3600) / 60);
    const second = totalSec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    const p = nowHKTParts(date);
    const pastMidnight = Number(p.hour) < 6;
    if (pastMidnight && remain > 18 * 60 * 60 * 1000) {
      return {
        clock: formatHKT(date),
        label: `已開售 · ${formatHKT(date)}`,
        open: true,
        remainMs: 0,
      };
    }
    return {
      clock: formatHKT(date),
      label: `距 00:00 HKT  ${pad(hour)}:${pad(minute)}:${pad(second)}`,
      open: remain <= 1000,
      remainMs: remain,
    };
  }

  return {
    STAGE_ACTIONS,
    ALERT_LABELS,
    actionFor,
    priorityFor,
    stageProgress,
    fingerprint,
    diffAlerts,
    formatHKT,
    saleCountdown,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.LiveAssist = LiveAssist;
}
