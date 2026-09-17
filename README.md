# TickPilot v2.4

**Stock radar during queue** + **post-queue accelerator** for HKTicketing and KKTIX.

## Two core jobs

### 1. Stock radar (while you wait in queue)

- Polls read-only iMaiTix inventory (`rest-sig.imaitix.com`) using your logged-in session
- HUD shows per-date stock: `Radar · 13 Nov: SOLD OUT · 14 Nov: 2 tier · ~48 left`
- Caches **Target · 14 Nov · HK$2099 · 12 left** before redirect
- Optional: **stop bot** if radar confirms all sold out (saves wasted waiting)
- Does **not** skip or shorten queue

### 2. Post-queue accelerator (after redirect)

- Uses cached API target to click the right **date + tier** immediately on select page
- **Turbo mode** (~90–130ms ticks) on select → seat → confirm
- Rotates dates / tier fallback if VIP gone
- Alert + sound when select page opens
- Stops at payment — you pay Visa manually within 5 min

## Install

1. `chrome://extensions` → Developer mode → Load unpacked → this folder
2. Reload after updates

## Recommended settings

| Setting | Value |
|---|---|
| Stock radar | ON |
| Stop if all sold out in queue | ON |
| Post-queue turbo | ON |
| Rotate sessions | ON |
| Tier fallback | ON |
| Min / Max HK$ | 699 – 3099 |
| Dual-tab early entry | ON |
| Start | ~11:25 HKT on event page |

## Flow

```
Event page → Buy click → Queue (RADAR polls stock) → Redirect → Select (ACCELERATOR) → Confirm → Pay (manual)
```

## Limits

- Queue length is server-side — cannot skip
- iMaiTix has no public cart/queue API for buyers
- High-demand events may sell out before long queues clear
