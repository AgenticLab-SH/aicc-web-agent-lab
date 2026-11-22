# windows-design 선택 절차

이 문서에서 선택한 단계만 읽는다. 명령 예제의 기준 작업 폴더와 인라인 리소스 경로는 상위 스킬 루트다. Markdown 링크는 이 파일 위치를 기준으로 한다.

## Step 1c — UI decision brief

Before code, read:

- `references/ui-patterns/surface-taxonomy.md`
- `references/ui-patterns/ui-decision-brief.md`
- `references/ui-patterns/desktop-app-archetypes.md`
- `references/ui-patterns/native-desktop-app-quality-contract.md`
- `references/ui-patterns/originality-engine.md`
- `references/ui-patterns/design-recipes.md`
- `references/ui-patterns/anti-default-contrasts.md`
- `references/ui-patterns/visual-hierarchy.md`
- `references/ui-patterns/motion-budget.md`

Write the UI decision brief, desktop archetype brief, native desktop quality brief, originality brief when relevant, and a compact layout sketch before code. Pick the app shape before picking controls: command center, library/collection, workbench, monitoring cockpit, tray utility, media/consumer, document/knowledge, or setup/preferences. Then choose a composition archetype from the product subject: cockpit, command deck, ledger, timeline wall, studio desk, light table, archive index, inspection bay, instrument panel, or another concrete premise. Define window model, command model, resize behavior, native controls, keyboard/focus paths, state coverage, and platform evidence. If the sketch becomes sidebar + cards + table, use anti-default contrasts and rewrite it. Windows utilities and admin tools should favor operational density, stable navigation, command surfaces, inspectors, timelines, and low motion. Use SettingsCard/NavigationView strongly for preferences and system-like utilities, but do not make every Windows app a settings shell. Branded consumer apps may use richer content surfaces, but native chrome, Mica/Acrylic rules, Segoe UI Variable, and Fluent icons still apply.

## Step 2a — Branded vs system-like (only if track 1 or 2 picked)

Track 1 = system-like. Track 2 = branded. The user already picked. Skip to step 2.

For reference: branded means native chrome + bespoke content surface. Read `references/branded-fluent.md`.

## Step 2 — WinUI 3 idioms

Every Win11 app must:
- Extend the title bar into the client area via `AppWindow.TitleBar` API (preserve Snap Layouts hover)
- Apply **Mica** as the top-level window backdrop (`SystemBackdrop="Mica"`) — opaque, desktop-tinted
- Apply **Acrylic** only to transient surfaces: flyouts, command bars, menus
- Use **Mica Alt** for tabbed apps (Terminal, Edge, Files)
- Use 8px corner radius on windows, 4px on controls, 0px in dense grids
- Use **tonal elevation** (background brush shifts) — never CSS-style drop shadows
- Wire light/dark via `ThemeResource` brushes, never hex literals

**Reveal effect** is deprecated in Win11 styling. Do not generate it.

## Step 3 — Typography & icons

- **Segoe UI Variable** is the default for system-like Windows chrome; preserve platform Korean glyph fallback and accessibility scaling. For branded content, retain the approved font system or choose a Korean-capable content font with `korean-ui-quality`. Follow actual control/font support rather than forcing variable axes on every host.
- **Segoe Fluent Icons** font for iconography. 1 epx monoline. Sizes: 16/20/24/32/40/48/64.
- For body text in productivity: weight 400, size 14, line height 20. For headlines: optical size adjusts automatically — let it.

## Step 4 — Layout components (use these, not custom)

| Need | Use |
|---|---|
| Top-level navigation | `NavigationView` (Left, LeftCompact, Top modes) |
| Settings | `SettingsCard` (CommunityToolkit.WinUI.Controls.SettingsControls) |
| Library / collection | `ListView` / `GridView` + preview pane + metadata panel |
| Workbench / editor | `CommandBar` + canvas/document area + right-side inspector |
| Monitoring / jobs | timeline/list + `InfoBar` states + detail pane |
| Tray utility | compact window or tray flyout + one primary status/action |
| Inline alert | `InfoBar` (Severity: Informational/Success/Warning/Error) |
| Coachmark | `TeachingTip` |
| Disclosure | `Expander` |
| Path / breadcrumb | `BreadcrumbBar` |
| Tabbed segment toggle | `SelectorBar` |

Refer to **WinUI Gallery** (https://github.com/microsoft/WinUI-Gallery) for canonical control usage. When generating, mirror its patterns exactly.

## Step 5 — Architecture

- **CommunityToolkit.Mvvm** (`[ObservableProperty]`, `[RelayCommand]`) — never raw `INotifyPropertyChanged`
- DI via `Microsoft.Extensions.Hosting`
- Settings persistence via `Windows.Storage.ApplicationData.Current.LocalSettings` or `Microsoft.UI.Xaml.Settings`
- Localization via `.resw` resource files (not hardcoded strings)

## Step 6 — Anti-slop ban list (Windows-specific)

Reject all of these:

- Inter / Roboto / system-ui on native chrome — only Segoe UI Variable
- CSS-style `box-shadow` — use tonal elevation brushes (`LayerFillColorDefaultBrush` etc.)
- Custom hamburger menu where `NavigationView` belongs
- Acrylic on long-lived window backgrounds (use Mica)
- Mica on flyouts (use Acrylic)
- Hardcoded hex colors — breaks dark mode + high contrast. ThemeResource only.
- Hand-rolled title bar that breaks Snap Layouts hover
- Square 90° corners
- Material Design ripples
- iOS-style segmented controls with sliding pill (use SelectorBar instead)
- Bottom tab bars (Android idiom)
- Custom scrollbars that override `ScrollViewer` (breaks dynamic thinning)
- FontAwesome / Material Symbols icons (use Segoe Fluent Icons)
- Marketing-page spacing in productivity/admin tools
- Decorative cards replacing SettingsCard, table/list, or master-detail surfaces
- Sidebar plus cards plus table as the default for every desktop app
- Branded originality that only changes colors while keeping the same generic shell

## Step 7 — Reference apps to emulate

- **Files** (files.community) — Mica + tabs + dual-pane + command palette
- **PowerToys** (recently redesigned by Niels Laute) — canonical NavigationView + InfoBar settings shell
- **Windows Terminal** — title-bar tab integration, JSON theming
- **Microsoft Photos (2024 rewrite)** — WinUI 3 + AI surfaces
- **Snipping Tool / Clipchamp** — modern command bar + teaching tips
- **DevHome** — dashboard widget pattern
- **Notepad (rewrite)** — minimal Fluent restraint

## Step 8 — Tokens & assets

- Token JSON (DTCG): see `assets/tokens/fluent-2.json` shipped with this plugin
- Fluent 2: https://fluent2.microsoft.design
- Win design downloads (Figma + icons + Segoe): https://learn.microsoft.com/windows/apps/design/downloads
- WinUI source: https://github.com/microsoft/microsoft-ui-xaml

Read `references/fluent-design.md` for deep token + spacing reference.

## Step 9 — Fidelity tradeoffs to communicate

When the user picks a non-native stack, **state the loss explicitly** in one line:
- Tauri 2: "~3MB binary, but WebView2 chrome — Mica still works via window-backdrop API but font rendering and focus rings will look subtly off vs WinUI 3."
- Avalonia: "Cross-platform but Fluent theme is custom-drawn, not 1:1 with Win11."
- Electron: "Don't. Use Tauri 2 if web stack is mandated."

