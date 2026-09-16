# TickPilot — AI Handoff / Project Analysis Guide

This document helps another AI (or developer) understand the TickPilot project quickly and correctly.

---

## 1. What this project is

**TickPilot** is a Chrome Extension (Manifest V3) modeled after **TechTickBot** for ticket-buying workflows. It supports both **mirror test arena** and **live-site automation** on:

- **HKTicketing** (`hkt.hkticketing.com`, `busy.hkticketing.com`)
- **KKTIX** (`kktix.com`)
- Also detects: Cityline, URBTIX (generic HUD + alerts)

---

## 2. Repository layout

```
extension/
├── README.md                 # Short entry point
├── PROJECT.md                # This file — full AI handoff
├── .gitignore
└── chrome-extension/         # ← Load THIS folder in chrome://extensions
    ├── manifest.json         # MV3 manifest v1.3.0
    ├── background.js         # Service worker — state, messages, badge, notifications
    ├── content.js            # Injected on live ticket sites — live assist HUD
    ├── content.css           # HUD / settings card / banner styles
    ├── popup.html/js/css     # Extension popup UI
    ├── icons/                # 16, 48, 128 PNG
    ├── lib/
    │   ├── tickpilot-options.js   # Shared defaults + parseZoneRange()
    │   └── live-assist.js         # Stage actions, alerts, HKT countdown (content script)
    └── demo/                 # Local mirror arena (extension page + standalone serve)
        ├── index.html        # Shell — platform switch via ?platform=hkt|kktix
        ├── app.js            # HKTicketing SPA mirror
        ├── kktix-mirror.js   # KKTIX mirror (only active when platform=kktix)
        ├── hkt-shared.js     # Selectors, stage detection, HKT timezone helpers
        ├── runner.js         # Automation engine (mirror only)
        ├── settings-ui.js    # TechTickBot-style settings card in mirror
        ├── styles.css
        ├── autotest.mjs      # Optional headless test (requires puppeteer via npx)
        └── lib/
            ├── tickpilot-options.js  # Copy for standalone `npx serve demo/`
            └── human-click.js        # Click helper for mirror (legacy, runner uses .click())
```

**Total source files (excluding node_modules): ~24 files**

---

## 3. Architecture diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        chrome.storage.local                        │
│                         key: "tickpilot"                         │
│  { options, runtime, command }                                   │
└───────────────┬───────────────────────────────┬─────────────────┘
                │                               │
        ┌───────▼────────┐              ┌───────▼────────┐
        │  background.js │◄────────────►│    popup.js    │
        │  (service worker)              │  (control panel)│
        └───────┬────────┘              └────────────────┘
                │
    messages    │  TICKPILOT_GET / SAVE / START / STOP / OPEN_ARENA
                │  TICKPILOT_RUNTIME / TICKPILOT_LIVE_ALERT
                │
        ┌───────▼────────────────────────────────────────┐
        │              content.js (live sites)            │
        │  + lib/live-assist.js                           │
        │  • Stage detection                              │
        │  • HUD + settings card + alert banner           │
        │  • NO clicks on live sites                      │
        └────────────────────────────────────────────────┘

        ┌────────────────────────────────────────────────┐
        │         demo/index.html (mirror arena)          │
        │  app.js (HKT) OR kktix-mirror.js (KKTIX)       │
        │  runner.js — full automation when started       │
        │  settings-ui.js — in-page config card           │
        └────────────────────────────────────────────────┘
```

---

## 4. State model (`chrome.storage.local.tickpilot`)

### `options` (user config — from popup)

| Key | Default | Purpose |
|---|---|---|
| `platform` | `"hkt"` | Mirror platform: `hkt` or `kktix` |
| `locale` | `"zh-HK"` | Live assist language (zh vs en) |
| `sessionIndex` | `1` | Function 2: pick Nth session (1-based) |
| `zoneRange` | `"1-3"` | Function 2: ticket zone filter |
| `quantity` | `2` | Ticket qty 1–10 |
| `kktixPriceIndex` | `2` | KKTIX mirror: price row index |
| `memberNumber` | `"TP-2048"` | Mirror auto-fill; live = copy button only |
| `presetAnswer` | `"Telegram"` | Verification answer (mirror) |
| `function1Enabled` | `false` | Retry same fare (manual pre-select first) |
| `function2Enabled` | `true` | Intelligent auto select |
| `skipObstructed` / `skipWheelchair` | `true` | Tier filters |
| `autoConsent` | `true` | Auto-check terms in mirror |
| `interval` / `maxRetries` | `500` / `80` | Runner timing |
| `saleDelayMs` | `12000` | Mirror: ms until simulated 00:00 HKT |
| `liveAssistEnabled` | `true` | Live site assist master switch |
| `alertStageChange` … `alertSound` | `true` | Per-alert toggles |

### `runtime` (live status)

| Key | Purpose |
|---|---|
| `running` | Mirror bot active |
| `completed` | Mirror flow finished |
| `platform` | `"arena"`, `"HKTicketing"`, `"idle"`, etc. |
| `message` | Last status line |
| `steps` | `{ queue, selection, form, complete }` — WAITING/RUNNING/DONE |
| `logs` | Activity strings (newest first) |
| `hkt` | `{ stage, stageLabel, hash, host, categories, sessions, captcha }` |
| `botActive` | Badge state |

### `command` (mirror control bus)

`{ type: "start"|"stop", at: timestamp, mode: "function1"|"function2" }`

Written by background on START/STOP; read by `runner.js` via `storage.onChanged`.

---

## 5. Message protocol (background.js)

| Message | Sender | Action |
|---|---|---|
| `TICKPILOT_GET` | popup, content, demo | Return full state |
| `TICKPILOT_SAVE_OPTIONS` | popup, settings-ui | Merge options |
| `TICKPILOT_OPEN_ARENA` | popup | Open `demo/index.html?platform=…` |
| `TICKPILOT_START` | popup, settings-ui | Set command, open arena, badge BOT |
| `TICKPILOT_STOP` | popup | Stop command |
| `TICKPILOT_RUNTIME` | runner.js, content.js | Update runtime + badge |
| `TICKPILOT_LIVE_ALERT` | content.js | Deduped alert → log + notification |
| `TICKPILOT_CLEAR_LOG` | popup | Clear activity log |

---

## 6. HKTicketing mirror flow (`demo/app.js`)

Simulates live SPA hash routes and host switching:

```
#/login
  → #/allEvents/detail?activityId=demo-neon-2026   (event page, 立即購票)
  → #/queue                                         (host → busy.hkticketing.com)
  → [00:00 HKT] 2× connection errors
  → #/allEvents/detail/selectTicket?activityId=…   (host → hkt.hkticketing.com)
  → #/allEvents/detail/seatMap?activityId=…
  → #/allEvents/detail/confirmOrder?activityId=…
  → #/allEvents/detail/payment?activityId=…
  → #/complete                                      (sets window.__HKT_TEST_RESULT__)
```

### Live-like DOM class prefixes (match real HKT for content script + runner)

- `[class*="sessionList___"]` + `fouceStyle___sel`
- `[class*="levelItem___"]` + `disableClass___off` / `reminderStyle___sel`
- `[class*="buyNum___"]` qty stepper
- `[class*="sellTicketBottomBtnWrap___"]` / `pcOrderBar___abc` bottom bar
- `[class*="ticketWrapRoot___"]`
- `[class*="seatMapCanvas___"]`

### Mirror state object (`HKTMirror.state`)

`loggedIn`, `saleAt`, `connectFails`, `inventoryFlipped`, `selectedSession`, `selectedCategory`, `qty`, `currentHost`, `queuePosition`, `connectionError`, `tiersLoading`

---

## 7. Runner (`demo/runner.js`) — mirror automation only

- Branches on `window.__TP_PLATFORM__` → `HKTMirror` or `KKTIXMirror`
- **Function 1**: only retries existing manual selection; waits if tier locked
- **Function 2**: auto session index, zone range, filters, qty, auto consent, member fill
- Steps: `login → queue → selection → form → complete`
- Publishes to background via `TICKPILOT_RUNTIME`
- Autotest: `?autotest=1` triggers `start()` on load

### Test result

```javascript
window.__HKT_TEST_RESULT__ = { ok: true, platform: "hkt"|"kktix", ... }
```

---

## 8. Live auto-buy (`lib/live-auto.js`)

Injected alongside `live-assist.js` on all live ticket sites. Provides full automation:

- **Queue handling**: exponential backoff retry (500ms → 8s cap), position tracking, 5-min timeout warning
- **Session selection**: by index (function 2) or pre-selected (function 1)
- **Tier/category selection**: zone range filter, price min/max, skip obstructed/wheelchair
- **Quantity stepper**: auto-increment to target qty
- **Next bar**: auto-click when all inputs valid
- **Confirmation**: member number auto-fill, agreement checkbox
- **Payment**: sandbox card field fill + pay submit

Activated from popup via **🚀 Live Function 1/2** buttons. Background script routes to the active live tab via `TICKPILOT_START_LIVE` message.

### Message protocol (live auto)

| Message | Direction | Purpose |
|---|---|---|
| `LIVE_AUTO_START` | background → content | Start automation with options |
| `LIVE_AUTO_STOP` | background → content | Stop automation |
| `TICKPILOT_LIVE_LOG` | content → background | Log entry to popup log |
| `TICKPILOT_LIVE_AUTO_STATUS` | content → background | Running stage heartbeat |

---

## 9. Live assist (`content.js` + `lib/live-assist.js`)

Injected on:

- `*.hkticketing.com`, `*.kktix.com`, `*.cityline.com`, `*.urbtix.hk`

### UI elements created

| ID | Purpose |
|---|---|
| `#tickpilot-probe` | Bottom-right HUD — stage, action guide, timeline |
| `#tickpilot-live-settings` | Top-left settings summary |
| `#tickpilot-alert-banner` | Top-center pulsing alert |
| `body.tp-assist-live` | ASSIST badge (top-right) |

### Stage detection (`detectHktStage`)

Uses **hash routes** and **hostname** (`busy.` → queue).

### Alerts (`LiveAssist.diffAlerts`)

Fires on: stage change, select open, tier unlock (+N categories), captcha, busy host, payment page, next bar visible.

**Does NOT**: click, type, refresh, or submit forms on live sites.

### HKT countdown

`LiveAssist.saleCountdown()` — time until next 00:00 HKT, updates every 1s.

---

## 9. KKTIX mirror (`demo/kktix-mirror.js`)

Only initializes when `?platform=kktix`:

```
#/login → #/countdown → #/select → #/form → #/complete
```

Price rows use class `kktix-price` + `levelItem___abc` pattern.

---

## 10. How to run

### Extension

```
chrome://extensions → Developer mode → Load unpacked → chrome-extension/
```

Pin **TickPilot Test** → configure popup → **Start Function 2** or **Open mirror arena**.

### Standalone mirror (no extension)

```bash
cd chrome-extension/demo
npx serve -l 4180
# HKT:   http://localhost:4180/?autotest=1
# KKTIX: http://localhost:4180/?autotest=1&platform=kktix
```

### Autotest (optional)

```bash
cd chrome-extension/demo
npx serve -l 4180 &
npx -p puppeteer node autotest.mjs
```

---

## 11. What was removed (cleanup)

| Removed | Reason |
|---|---|
| `demo/node_modules/` | Accidental puppeteer install (~2200 files) |
| `test-page.html` | Legacy unused demo page |
| `lib/human-click.js` (root) | Unused duplicate; mirror uses `demo/lib/human-click.js` |

---

## 12. Common AI tasks — safe vs unsafe

### Safe to implement

- Improve mirror fidelity to live HKT UI
- Fix runner bugs, autotest, popup UX
- Better stage detection selectors on live sites
- KKTIX/Cityline/URBTIX live assist parity
- Live auto-buy enhancements (selectors, queue handling, retry logic, payment flow)

### Do NOT implement

- Intentionally breaking the ticket purchasing flow
- Bypassing payment or verification intentionally

---

## 13. Key files to read first

1. `manifest.json` — permissions, content script matches
2. `lib/tickpilot-options.js` — all defaults
3. `background.js` — message hub
4. `demo/runner.js` — automation logic
5. `demo/app.js` — HKT mirror pages
6. `content.js` — live assist behavior
7. `lib/live-assist.js` — alert rules + countdown

---

## 15. Version

- Extension version: **1.4.0** (`manifest.json`)
- Last major features: Live auto-buy engine (queue, selection, confirm, payment), live tab routing, popup live controls, LiveAuto with exponential backoff
