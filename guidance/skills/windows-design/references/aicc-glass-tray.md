# Compact glass tray example

Use this for the existing AICC tray or a similarly compact operational popover when the user wants this direction. Do not apply glass, blue branding or this layout to every product.

## Provenance and limits

The user explicitly approved the installed design on 2026-10-18 and asked to reuse it in the design skill. Implementation lives in `tools/platform/windows/AiccStatusTray.cs`, `AiccStatusTrayPanel.cs`, `AiccStatusTrayCredits.cs` and `AiccTrayIdentity.cs` in the AICC source root. Current decisions and installation receipts live in `specs/tray-resilience/`. The source was built and installed; automated checks, instrumented performance measurement and independent runtime UI verification were not performed. User acceptance of appearance is not evidence for every interaction or accessibility state.

## Decisions worth reusing

- Keep the main object visible immediately: account usage, reset times, state, order and credit summary. Selecting an account changes the action target, not whether its basic information appears.
- Use cool frosted surfaces with restrained edge highlights and a single blue action/selection accent. Large bright figures carry the hierarchy; secondary information remains legible. Preserve text explanations for warning and busy states.
- Use installed Korean-aware body fonts, native display numerals and cached font sets. A shared Font must stay alive while any child control retains it, including hidden controls. Avoid font downloads for a utility.
- Make each action have one home. Keep one account selector, one primary action area and one feedback line. Put copy and display preferences in Settings. Do not announce successful navigation/selection over useful observation timestamps.
- Use one scrolling content plane for both painting and interactive controls. Fixed navigation/actions remain outside it. Fit popup bounds to the invoking monitor and work area; clamp moves and DPI/display changes. Never reposition on data refresh.
- Preserve the paint clip for every GDI TextRenderer call, as well as its coordinate transform; an opaque buffered surface must repaint its invalidated background before content. For task titles supplied by a child process, specify UTF-8 at both writer and reader. See [text boundaries](winforms-text-boundaries.md) for the observed CP949/UTF-8 incident and narrow repair.
- Compare accounts in two columns where space allows and one where narrow. Prefer a compact summary over repeated headings, empty containers or instructions attached to every row. Shorten copy without removing metric meaning, stale state or mutation uncertainty.
- For this tray, every explicit opening starts pinned. Pin means staying open across focus changes and above normal windows; it does not prevent dragging. Keep a visible unpin control, Esc/close to hide and a tray click to reopen. Do not impose this behavior on other apps without a brief.
- Account presentation uses a shared formatter: preserve an existing numbered label; mask the account part as first grapheme + `***` + last grapheme. For one/two graphemes reveal only the first. Use the same formatter in cards, menus, pickers, order lists, accessibility, feedback, tooltip and copied status. Keep exact opaque identifiers for actions; never resolve accounts by a masked label.
- Draw one recognisable account-hub icon for tray/window/executable/shortcuts. Cache status variants, simplify at small sizes, pair color with text and avoid animated tray icons.
- A single cached snapshot feeds the views. Render cached observations promptly, mark stale/error data and defer slower probes. Hiding the window lowers collection cost; decoration adds no polling or animation timer.

## Material and readability tradeoff

The WinForms example uses inexpensive frosted painting, optional native frame backdrop and restrained 96 percent whole-window opacity. It is not Apple's proprietary Liquid Glass or independent background-only blur: GDI text participates in the window compositing too. Preserve this distinction when describing it. High contrast, remote sessions or disabled Windows transparency restore full-opacity solid surfaces. Keep an explicit Glass setting. If a future task needs stronger translucency while retaining fully opaque text, choose a supported composited rendering surface as a separately scoped change rather than lowering whole-window opacity further.

Reference: [Apple materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials), consulted 2026-10-18. Use material to support hierarchy and legibility; accessibility and the product's platform take precedence.

## Feature placement

For additional OCX/AICC/Codex functions, show the smallest useful state or action and link to its existing owner. Do not clone the whole dashboard, add a second scheduler or infer current support from a vendored GUI. Distinguish source availability, installed capability, observation and successful execution. Keep order drafts, explicit account actions and uncertain-result fences intact.

## Existing AICC tray and approved glass example

For an existing AICC tray refinement, keep its WinForms host and the user's accepted direction; do not reopen the framework choice. Read [the compact glass tray example](aicc-glass-tray.md) when the task involves this tray, a dense monitoring popover, account privacy or restrained translucent surfaces. It records a user-approved example, not a mandatory theme for unrelated apps. Current explicit user choices and platform accessibility preferences take precedence over the track defaults below.

For broken Korean titles, replacement characters, scrolling text trails or owner-drawn WinForms surfaces, read [text transport and paint boundaries](winforms-text-boundaries.md). Separate stored data, child-process encoding and GDI clipping before changing fonts or materials. Follow the current model's verification policy; implementation and installation do not prove visual acceptance.

For every user-facing control change, include readable normal/disabled/selected/focus states and explain purpose, use, effect and unmet prerequisites. Read [visibility and action help](visibility-and-action-help.md) for contrast, inline explanations, hover/focus help and touch alternatives. Essential instructions must remain available without hovering. This applies to the main window and auxiliary dialogs alike.

For Korean/English typography, copy and resilient text layout, use [korean-ui-quality](../../korean-ui-quality/SKILL.md) alongside this skill. Preserve native chrome and the selected track; shared content-font defaults do not replace Windows system typography. Read only the Windows reference section. Verification follows current model policy and the user's explicit scope.

