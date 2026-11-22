---
name: windows-design
description: Windows 앱·WinUI/WPF·Fluent·Tauri/Electron UI 구현. 먼저 트랙 확인 후 상태·접근성·시각 규칙 적용. 웹·Apple·Android 전용 제외.
---

# windows-design — pick the track first

Windows desktop has four distinct tracks. Each has different visual ceilings, different cost. **Ask the user which one before any code.** Do not default.

## What This Skill Can Do

- Choose the right Windows track: strict WinUI, branded WinUI, Tauri, or Electron.
- Design desktop archetypes such as command centers, libraries, workbenches, monitoring cockpits, tray utilities, media apps, document apps, and settings/preferences.
- Preserve UX briefs, state coverage, command hierarchy, keyboard paths, inspector/detail panes, and recovery flows.
- Apply Fluent, Mica/Acrylic, Segoe UI Variable, Fluent icons, SettingsCard, NavigationView, InfoBar, and Windows density rules.
- Avoid generic sidebar/cards/table shells by using product-specific composition and anti-default rewrites.

## Existing AICC tray and approved glass example

이 단계는 [상세 절차](references/aicc-glass-tray.md)의 같은 절을 읽고 수행한다.

## Step 1 (MANDATORY) — Ask the user which track

Present these four options verbatim. Do not pick for them.

> Which track do you want for this app?
>
> **1. System-like native (WinUI 3 strict)** — feels like Settings/Calculator/Notepad. Best for: productivity utilities, internal tools, system panels. Visual ceiling: medium. Binary ~30MB. Users who care: Windows power users, IT admins. Examples: PowerToys, Snipping Tool, Sound Recorder.
>
> **2. Branded native (WinUI 3 + branded Fluent)** — native chrome (Mica, Snap Layouts, ThemeResource auto dark/light/HC) but bespoke content surface (custom accent, custom display font, hero atmospheres, magazine layouts). Best for: consumer apps that want fit-in *and* identity. Visual ceiling: high but XAML-bound. Binary ~30MB. Examples: Apple Music for Windows, Files (community), Microsoft Photos rewrite, DevHome.
>
> **3. Tauri 2 + React/Tailwind/Motion** — same React code as Electron but uses Windows' built-in WebView2 instead of bundled Chromium. Full visual freedom (mesh gradients, custom motion, real imagery, anything CSS can do). Binary ~5–10MB. RAM ~30–80MB. Mica still available via Tauri API. Examples: Cap, Spacedrive, ClashVerge, Pot.
>
> **4. Electron + React/Tailwind/Motion** — bundles full Chromium. Same dev experience as Tauri but heavier. Binary ~150–250MB. RAM ~300–500MB. Largest ecosystem, every dev knows it. Examples: Spotify, Discord, VSCode, Slack, Notion, Figma desktop, Claude desktop, ChatGPT desktop.
>
> Which? Or describe priorities (binary size, visual ambition, brand vs fit-in) and I'll pick.

If the user has already given enough signal in the brief (e.g. "I want a system tray utility" → 1; "I want it to look like Awwwards site" → 3; "Spotify-style" → 3 or 4), state your pick + reasoning in one sentence and proceed. But if ambiguous, ask.

## Step 1b — Once picked, route

| Track | Reference docs | Default stack |
|---|---|---|
| 1. System-like WinUI 3 | `references/fluent-design.md` | WinUI 3 + current stable Windows App SDK + CommunityToolkit.Mvvm + SettingsControls |
| 2. Branded WinUI 3 | `references/fluent-design.md` + `references/branded-fluent.md` | Same as 1 + custom accent override + embedded display font + bespoke surfaces |
| 3. Tauri 2 + Web | `references/web-fonts.md` + `references/web-motion.md` + `references/web-bans.md` + `references/awwwards-ceiling.md` | React 19 + Tailwind v4 + Motion (motion.dev) + Tauri 2 shell |
| 4. Electron + Web | Same as 3 | React 19 + Tailwind v4 + Motion + Electron shell + electron-builder |

For tracks 3 and 4, the web design rules from `web-design` SKILL apply — same anti-slop ban list, same typography curation, same aesthetic direction discipline.

## Step 1c — UI decision brief

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

## Step 2a — Branded vs system-like (only if track 1 or 2 picked)

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

## Step 2 — WinUI 3 idioms

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

## Step 3 — Typography & icons

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

## Step 4 — Layout components (use these, not custom)

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

## Step 5 — Architecture

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

## Step 6 — Anti-slop ban list (Windows-specific)

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

## Step 7 — Reference apps to emulate

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

## Step 8 — Tokens & assets

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

## Step 9 — Fidelity tradeoffs to communicate

이 단계는 [상세 절차](references/implementation-checklist.md)의 같은 절을 읽고 수행한다.

