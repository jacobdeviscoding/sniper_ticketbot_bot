# TickPilot Test



TechTickBot-style Chrome extension with **local mirror arenas** for HKTicketing and KKTIX. Full automation runs only in the test arena — live sites are detect-only + settings display.



## Install



1. Open `chrome://extensions`

2. Enable **Developer mode**

3. **Load unpacked** → select this `chrome-extension` folder

4. Pin **TickPilot Test**



## TechTickBot feature parity



| Feature | Mirror arena | Live site |

| --- | --- | --- |

| Platform toggle (HKT / KKTIX) | Yes | Settings card shows choice |

| Member number auto-fill | Yes | Display only |

| Preset / verification answer | Yes | Display only |

| Auto consent terms | Yes | Display only |

| **Function 1** — retry same fare | Yes | Display only |

| **Function 2** — session index, zone range, qty, filters | Yes | Display only |

| Skip obstructed / wheelchair | Yes | Display only |

| Queue + HKT midnight timing | HKT mirror | Detect only |

| KKTIX countdown + price index | KKTIX mirror | Detect only |

| BOT badge when armed | Yes | Yes |

| Settings card under navbar | Mirror | Floating panel |

| Payment | Sandbox test card | Manual only |

## HKT mirror live fidelity

The HKT mirror now tracks the real site flow more closely:

- **Host switch**: `hkt.hkticketing.com` ↔ `busy.hkticketing.com` (header + dark queue theme)
- **Routes**: `#/login` → event detail → `#/queue` → `selectTicket` → `seatMap` → `confirmOrder` → `payment`
- **00:00 HKT timing** with 2× connection errors (連線失敗) before tiers load
- **Traditional Chinese** UI: 登入, 立即購票, 下一步, 分配座位, 我已閱讀並同意
- **Live DOM classes**: `sessionList___`, `levelItem___`, `buyNum___`, `sellTicketBottomBtnWrap___`, `ticketWrapRoot___`
- **Tier skeleton** flash when inventory unlocks after queue

## Popup controls



- **Platform** — HKTicketing or KKTIX mirror

- **General** — member number, verification answer, auto consent, auto start

- **Function 1** — enable retry-same-fare (pick session/tier/qty manually first)

- **Function 2** — session index, zone range (`1-3`), KKTIX price index, quantity, min/max HK$, skip obstructed/wheelchair

- **Start Function 2** (green) / **Start Function 1** — opens mirror and runs workflow

- **Open mirror arena** — opens test page without starting



## Run the mirror



### Via extension



1. Configure popup → **Start Function 2** (or open arena first, use settings card)

2. HKT flow: login → queue → select → seat → confirm → sandbox payment → **TEST OK**

3. KKTIX flow: login → countdown → select price → form → **TEST OK**



### Autotest (no extension)

```bash
cd demo
npx serve -l 4180
# Manual: open http://localhost:4180/?autotest=1
# Headless: npx -p puppeteer node autotest.mjs
```

Check `window.__HKT_TEST_RESULT__.ok === true` in DevTools console.



## Live assist (HKTicketing)



On live HKTicketing, TickPilot helps you buy **manually**:



- **ASSIST** badge + stage pill (登入 → 等候室 → 選票 → 座位 → 確認 → 付款)

- **What to do now** guide in Traditional Chinese per stage

- **Alerts** when: stage changes, selectTicket opens, tiers unlock, captcha appears, queue host (`busy.`), payment page

- **Top banner** + optional desktop notification + sound on critical alerts

- **Activity timeline** in the HUD + log in popup

- **Settings card** shows your target session, zone, qty



Configure in popup → **Live assist · HKTicketing**. No auto-click, refresh, or checkout on live sites.



## Files



| Path | Role |

| --- | --- |

| `popup.html/js/css` | TechTickBot-style control panel |

| `background.js` | State, arena opener, BOT badge |

| `content.js` | Live detect + settings display |

| `lib/tickpilot-options.js` | Shared defaults |

| `demo/index.html` | Mirror shell + settings card |

| `demo/app.js` | HKTicketing SPA mirror |

| `demo/kktix-mirror.js` | KKTIX mirror |

| `demo/runner.js` | Function 1/2 automation (mirror only) |

