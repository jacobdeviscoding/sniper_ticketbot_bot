/** On-page HUD — stock radar (queue) + post-queue accelerator (select) */
(function initTickPilotHud() {
  const STAGE_LABELS = {
    login: "Login",
    event: "Event",
    busy: "Queue",
    waitingRoom: "Waiting room",
    select: "Select · ACCEL",
    seat: "Seat · ACCEL",
    confirm: "Confirm · ACCEL",
    pay: "Payment",
    complete: "Complete",
    unknown: "—",
  };

  const MODE_LABELS = {
    idle: "",
    radar: "STOCK RADAR",
    accelerate: "ACCELERATOR",
    armed: "ARMED",
  };

  const MAX_LOG = 12;
  let timeline = [];

  function stageLabel(stage) {
    return STAGE_LABELS[stage] || stage || "—";
  }

  function nowStamp() {
    return new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  }

  function render() {
    const running = typeof LiveAuto !== "undefined" && LiveAuto.isRunning?.();
    const stage = LiveAuto?.detectCurrentStage?.() || "unknown";
    const mode = LiveAuto?.getHudMode?.() || "idle";

    let root = document.getElementById("tickpilot-hud");
    if (!root) {
      root = document.createElement("aside");
      root.id = "tickpilot-hud";
      document.documentElement.appendChild(root);
    }

    if (!running && !timeline.length) {
      root.style.display = "none";
      document.body?.classList.remove("tp-bot-armed");
      return;
    }
    document.body?.classList.toggle("tp-bot-armed", running);

    root.style.display = "";
    const logs = timeline.length
      ? timeline.map((row) => `<li class="tp-${row.priority || "info"}"><time>${row.at}</time> ${row.text}</li>`).join("")
      : `<li><time>${nowStamp()}</time> Bot armed…</li>`;

    const apiLine = LiveAuto?.getApiStatusLine?.() || "";
    const targetLine = LiveAuto?.getApiBestOfferLine?.() || "";
    const modeLabel = MODE_LABELS[mode] || "";
    const warn = mode === "radar"
      ? "Stock radar — do not refresh during queue."
      : mode === "accelerate"
        ? "Accelerator — picking tier fast. Pay within 5 min."
        : "Do not refresh during queue.";

    root.innerHTML = `
      <div class="tp-hud-head">
        <strong>TickPilot</strong>
        <span class="tp-hud-badge">${running ? "BOT" : "OFF"}</span>
      </div>
      ${modeLabel ? `<p class="tp-hud-mode tp-mode-${mode}">${modeLabel}</p>` : ""}
      <p class="tp-hud-stage">${stageLabel(stage)}</p>
      ${apiLine ? `<p class="tp-hud-api">${apiLine}</p>` : ""}
      ${targetLine ? `<p class="tp-hud-target">${targetLine}</p>` : ""}
      <p class="tp-hud-host">${location.hostname}${location.hash ? location.hash.slice(0, 48) : ""}</p>
      <p class="tp-hud-warn">${warn}</p>
      <ul class="tp-hud-log">${logs}</ul>
    `;
  }

  window.addEventListener("tp-liveauto-log", (e) => {
    const { at, text, priority } = e.detail || {};
    timeline.push({ at: at || nowStamp(), text: text || "", priority: priority || "info" });
    if (timeline.length > MAX_LOG) timeline.shift();
    render();
  });

  setInterval(render, 500);
  render();
})();
