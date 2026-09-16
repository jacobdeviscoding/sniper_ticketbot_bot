function $(id) {
  return document.getElementById(id);
}

function send(type, extra) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function readOptionsFromForm() {
  const platform = document.querySelector('input[name="platform"]:checked')?.value || "hkt";
  return {
    platform,
    locale: "zh-HK",
    interval: Number($("refresh-interval").value),
    maxRetries: Math.max(1, Number($("max-retries").value) || 80),
    quantity: Math.min(10, Math.max(1, Number($("quantity").value) || 1)),
    sessionIndex: Math.max(1, Number($("session-index").value) || 1),
    zoneRange: $("zone-range").value.trim() || "1-3",
    kktixPriceIndex: Math.max(1, Number($("kktix-price").value) || 2),
    minPrice: Number($("min-price").value) || 0,
    maxPrice: Number($("max-price").value) || 100000,
    memberNumber: $("member-number").value.trim(),
    presetAnswer: $("preset-answer").value.trim(),
    autoConsent: $("auto-consent").checked,
    autoStart: $("auto-start").checked,
    function1Enabled: $("function1").checked,
    function2Enabled: $("function2").checked,
    skipObstructed: $("skip-obstructed").checked,
    skipWheelchair: $("skip-wheelchair").checked,
    liveAssistEnabled: $("live-assist").checked,
    alertStageChange: $("alert-stage").checked,
    alertSelectOpen: $("alert-select").checked,
    alertTierUnlock: $("alert-tier").checked,
    alertCaptcha: $("alert-captcha").checked,
    alertQueue: $("alert-queue").checked,
    alertPayment: $("alert-payment").checked,
    alertDesktop: $("alert-desktop").checked,
    alertSound: $("alert-sound").checked,
  };
}

function writeOptionsToForm(options) {
  document.querySelector(`input[name="platform"][value="${options.platform || "hkt"}"]`).checked = true;
  $("refresh-interval").value = String(options.interval || 500);
  $("max-retries").value = options.maxRetries ?? 80;
  $("quantity").value = options.quantity ?? 2;
  $("session-index").value = options.sessionIndex ?? 1;
  $("zone-range").value = options.zoneRange || "1-3";
  $("kktix-price").value = options.kktixPriceIndex ?? 2;
  $("min-price").value = options.minPrice ?? 0;
  $("max-price").value = options.maxPrice ?? 100000;
  $("member-number").value = options.memberNumber || "";
  $("preset-answer").value = options.presetAnswer || "";
  $("auto-consent").checked = options.autoConsent !== false;
  $("auto-start").checked = Boolean(options.autoStart);
  $("function1").checked = Boolean(options.function1Enabled);
  $("function2").checked = options.function2Enabled !== false;
  $("skip-obstructed").checked = options.skipObstructed !== false;
  $("skip-wheelchair").checked = options.skipWheelchair !== false;
  $("live-assist").checked = options.liveAssistEnabled !== false;
  $("alert-stage").checked = options.alertStageChange !== false;
  $("alert-select").checked = options.alertSelectOpen !== false;
  $("alert-tier").checked = options.alertTierUnlock !== false;
  $("alert-captcha").checked = options.alertCaptcha !== false;
  $("alert-queue").checked = options.alertQueue !== false;
  $("alert-payment").checked = options.alertPayment !== false;
  $("alert-desktop").checked = options.alertDesktop !== false;
  $("alert-sound").checked = options.alertSound !== false;
}

function setStep(name, status) {
  const row = document.querySelector(`[data-step="${name}"]`);
  if (!row) return;
  row.classList.toggle("active", status === "RUNNING");
  row.classList.toggle("done", status === "DONE");
  const b = row.querySelector("b");
  if (b) b.textContent = status === "DONE" ? "READY" : status;
}

function renderLog(logs) {
  const list = $("activity-log");
  if (!logs?.length) {
    list.innerHTML = '<li class="empty">No activity yet.</li>';
    return;
  }
  list.innerHTML = logs.slice(0, 12).map((line) => `<li>${line}</li>`).join("");
}

function render(state) {
  if (!state) return;
  const runtime = state.runtime;
  const pill = $("live-pill");
  const onLive = runtime.platform === "HKTicketing" && !runtime.running;
  pill.textContent = runtime.running ? "BOT ON" : onLive ? "ASSIST" : runtime.completed ? "READY" : "STANDBY";
  pill.className = `pill${runtime.running ? " live" : onLive ? " assist" : runtime.completed ? " ready" : ""}`;

  const plat = state.options?.platform === "kktix" ? "KKTIX mirror" : "HKTicketing mirror";
  $("platform-label").textContent = runtime.platform === "arena" ? plat : runtime.platform === "HKTicketing"
    ? "HKTicketing · live assist" : runtime.platform && runtime.platform !== "idle"
      ? `${runtime.platform} · assist` : "Arena offline";

  $("page-title").textContent = runtime.hkt?.hash
    ? runtime.hkt.hash.replace(/^#/, "")
    : runtime.pageTitle || "Open the mirror arena.";
  $("status-message").textContent = runtime.message || "Ready.";
  $("step-count").textContent = `${runtime.completedSteps || 0} / 4`;
  $("progress-bar").style.width = `${Math.min(100, ((runtime.completedSteps || 0) / 4) * 100)}%`;

  ["queue", "selection", "form", "complete"].forEach((step) => {
    setStep(step, runtime.steps?.[step] || "WAITING");
  });

  const isRunning = Boolean(runtime.running);
  const isLive = runtime.platform === "HKTicketing" && runtime.botActive;
  $("start-f1").disabled = isRunning;
  $("start-f2").disabled = isRunning;
  $("stop").disabled = !isRunning;
  $("start-live-f1").disabled = isRunning;
  $("start-live-f2").disabled = isRunning;
  $("stop-live").disabled = !isLive;
  renderLog(runtime.logs);
}

async function hydrate() {
  const result = await send("TICKPILOT_GET");
  if (!result?.ok) return;
  writeOptionsToForm(result.state.options);
  render(result.state);
}

function saveOptions() {
  send("TICKPILOT_SAVE_OPTIONS", { options: readOptionsFromForm() });
}

$("open-arena").addEventListener("click", () => {
  saveOptions();
  send("TICKPILOT_OPEN_ARENA", { options: readOptionsFromForm() });
});

$("start-f2").addEventListener("click", async () => {
  const options = { ...readOptionsFromForm(), function2Enabled: true, function1Enabled: false };
  const result = await send("TICKPILOT_START", { options, mode: "function2" });
  if (result?.ok) render(result.state);
});

$("start-f1").addEventListener("click", async () => {
  const options = { ...readOptionsFromForm(), function1Enabled: true, function2Enabled: false };
  const result = await send("TICKPILOT_START", { options, mode: "function1" });
  if (result?.ok) render(result.state);
});

$("stop").addEventListener("click", async () => {
  const result = await send("TICKPILOT_STOP");
  if (result?.ok) render(result.state);
});

$("start-live-f2").addEventListener("click", async () => {
  const options = { ...readOptionsFromForm(), function2Enabled: true, function1Enabled: false };
  const result = await send("TICKPILOT_START_LIVE", { options, mode: "function2" });
  if (result?.ok) render(result.state);
});

$("start-live-f1").addEventListener("click", async () => {
  const options = { ...readOptionsFromForm(), function1Enabled: true, function2Enabled: false };
  const result = await send("TICKPILOT_START_LIVE", { options, mode: "function1" });
  if (result?.ok) render(result.state);
});

$("stop-live").addEventListener("click", async () => {
  const result = await send("TICKPILOT_STOP");
  if (result?.ok) render(result.state);
});

$("clear-log").addEventListener("click", async () => {
  const result = await send("TICKPILOT_CLEAR_LOG");
  if (result?.ok) render(result.state);
});

document.querySelectorAll("input, select").forEach((el) => {
  el.addEventListener("change", saveOptions);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tickpilot) render(changes.tickpilot.newValue);
});

hydrate();
