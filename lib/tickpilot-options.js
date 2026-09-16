/** Shared TickPilot / TechTickBot-style option defaults */
const TICKPILOT_DEFAULTS = {
  platform: "hkt",
  locale: "zh-HK",
  interval: 500,
  maxRetries: 80,
  saleDelayMs: 12000,
  quantity: 2,
  sessionIndex: 1,
  sessionMatch: "27 Jun",
  zoneRange: "1-3",
  kktixPriceIndex: 2,
  minPrice: 0,
  maxPrice: 100000,
  memberNumber: "TP-2048",
  fullName: "Alex Chan",
  email: "alex.chan@example.com",
  password: "demo-pass-123",
  phone: "5123 4567",
  presetAnswer: "Telegram",
  verificationAnswer: "香港",
  autoConsent: true,
  autoStart: false,
  function1Enabled: false,
  function2Enabled: true,
  skipObstructed: true,
  skipWheelchair: true,
  allowRefresh: false,
  liveAssistEnabled: true,
  alertStageChange: true,
  alertSelectOpen: true,
  alertTierUnlock: true,
  alertCaptcha: true,
  alertQueue: true,
  alertPayment: true,
  alertActionReady: true,
  alertDesktop: true,
  alertSound: true,
  assistCompactHud: false,
};

function parseZoneRange(text) {
  const m = String(text || "1-3").match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return { min: 1, max: 99 };
  return { min: Math.min(+m[1], +m[2]), max: Math.max(+m[1], +m[2]) };
}

if (typeof globalThis !== "undefined") {
  globalThis.TICKPILOT_DEFAULTS = TICKPILOT_DEFAULTS;
  globalThis.parseZoneRange = parseZoneRange;
}
