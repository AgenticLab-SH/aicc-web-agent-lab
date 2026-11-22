# Visibility and action help

Use when creating or changing a user-facing control, workflow or auxiliary dialog. Preserve the existing product language and visual direction. This contract applies to Codex and ChatGPT work; a platform-specific implementation can differ.

## Readability and states

- Define foreground and background together for normal, hovered, pressed, selected, focused, disabled, loading and error states. Reuse the existing theme-aware component, including in popups and secondary windows. Do not assume a form's ForeColor controls native disabled-button rendering.
- Target at least 4.5:1 for ordinary informative text and 3:1 for large text. Include placeholders and help text. In this product, keep disabled action names and explanations readable too; that is an explicit usability choice beyond WCAG's inactive-control exception. Do not label an unmeasured palette compliant.
- Support system high contrast and a solid fallback for translucency. Distinguish state using text/shape in addition to color. Preserve font lifetime, UTF-8 transport and paint clipping independently.

## A control answers four questions

What does it do? How do I use it? What changes afterward? Why can I not use it now?

- Use a clear visible label; add concise plain-language help that supplies the missing information rather than repeating the label. Show prerequisite order near a multi-step flow, such as Select → Register → Enable.
- Show the selected target, current state and next action in a persistent region. A disabled button needs a reason and remedy. Do not enable a dangerous action merely to make its tooltip work.
- Supplement controls with hover help and keyboard-focus help/accessibility descriptions. Provide F1, a labelled help button or an equivalent touch/click popover for people who cannot hover. Disabled native controls may not receive mouse/focus events: supply an adjacent explanation or a parent hit-test help path.
- For custom hover/focus content, make it dismissible, reachable by the pointer and persistent while the user needs it; avoid covering its target. For long instructions, use a scrollable help view with a clear close action rather than an oversized tooltip. Native tooltips do not replace inline errors or required instructions.
- Describe the actual scope of an action. Queue tracking completion is not completion of a Codex goal. Enabled scheduling is not supported Desktop delivery. Opening a manager is not applying a setting. When ownership or version blocks an action, explain the next supported step without inventing a successful state.
- Fit instructions and controls at the window's minimum size and display scale. Let action rows wrap and help text scroll; keep status and next steps visible without overlapping the main list.

## Incident and application

The 2026-10-18 AICC continuity dialog used plain Button controls over a dark inherited background. Disabled rendering produced unreadable labels. It also hid prerequisites in button availability and used “goal complete” for queue-only completion. The repair reuses DarkTrayButton, adds persistent selection details, disabled reasons, hover/focus help and F1, and renames the queue-only action. It changes presentation and explanations while preserving the existing helper's action guards and protocol mismatch fence.

Current model policy and explicit user requests govern verification. Do not automatically run tests or visual checks when prohibited, and do not equate installation with visual acceptance. When checking is authorized, include disabled/loading/selection/high-contrast/focus states and narrow/DPI layouts, not only the initial enabled screen.

Sources: [WCAG contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [content on hover or focus](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html). These guide the implementation; no WCAG audit is claimed.
