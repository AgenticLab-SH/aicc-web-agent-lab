# Visitor-facing product page contract

Use this contract for public landing pages, feature pages, pricing introductions and product guides.
Its purpose is to prevent internal review surfaces from leaking into the visitor experience and to keep
connected routes concise, truthful and visually consistent.

## 1. Separate the audience first

Classify the surface before choosing its controls.

- `visitor`: understand the product, decide and begin;
- `reader`: understand policy, guidance or limitations;
- `operator`: complete an administrative task;
- `reviewer`: compare routes, viewports, builds or implementation states.

A public landing page is `visitor`, even when the product itself is an operator tool. Route trees,
viewport selectors, iframe canvases, build labels, source paths and QA controls belong to a separate
reviewer surface. Never add them to a visitor page merely because they help development.

## 2. Keep one visitor narrative

Use this default order and remove stages that do not earn a distinct communication job.

1. One plain-language promise.
2. One primary action.
3. One actual product demonstration.
4. Three to five short usage steps when the demonstration needs explanation.
5. One detail route for advanced scope, pricing, policy or recovery.
6. A short qualification and real footer navigation.

The hero, demonstration and steps must not restate the same sentence. The hero explains why, the media
shows what happens, and the steps explain how. Keep each fact in one canonical region.

## 3. Demonstrate the product truthfully

- Prefer a short GIF or video captured from the current rendered product flow.
- Pair motion with a still from the same recording for `prefers-reduced-motion`.
- Keep one workflow per media item and caption it with the observed action sequence.
- Edit the duration and framing so a visitor can follow the action without operating the product. A raw
  full-page recording or screenshot dropped into a frame is not an instructional demonstration.
- Crop or scale the real recording around the relevant action when the full interface makes it too small.
  Captions and step labels may explain the sequence, but they must not restage or invent product UI.
- State when test data or test credentials were used. Do not expose user data, secrets or private routes.
- Distinguish `available`, `login required`, `development` and `unknown` in visitor language.
- Never present a generated image, hand-animated mock, DOM-unhidden panel or static page screenshot as
  proof of a workflow.
- Never use a live-page iframe as product explanation unless the requested feature is explicitly an
  interactive sandbox. An iframe is not a substitute for editing, sequencing or captions.

## 4. Connect pages without repetition

- Share header, tokens, typography, link states, media treatment and status vocabulary.
- Give each route one dominant purpose. Do not clone the landing hero onto every page.
- Keep detailed legal, pricing and development information on their owning routes and link to it once.
- Preserve native links and browser history. Avoid custom navigation state when normal URLs suffice.
- Do not repeat the same navigation in header, body CTA, previous/next rail and footer. Each location must
  serve a different job.
- Treat redirects and aliases as routing implementation, not additional content pages.

## 5. Apply a copy budget

- H1: one idea, normally no more than two lines.
- Lead: one or two short sentences.
- Primary CTA: one. Secondary links stay visually subordinate.
- Workflow step: one action title and one explanatory sentence.
- Media caption: action sequence plus one truth or privacy qualification.
- Status explanation: say what the visitor can do and what remains unavailable; keep engineering evidence
  in nearby supporting text, not in an operator-style report headline.

Delete kickers, badges, cards, duplicated summaries and decorative labels that merely rename the heading.
Keep cards only when they enable real comparison, state or action.

## 6. Validate as a visitor

Confirm all of the following from a production build:

- the product, primary action and actual demonstration are understandable within five seconds;
- the demonstration plays or renders, and the still fallback carries the same meaning;
- 320px, 390px, tablet and desktop layouts recompose without horizontal overflow or clipped copy;
- keyboard focus, native links, previous/next navigation and browser back/forward work;
- every linked route inherits the visual system while retaining its own purpose;
- repeated headlines, claims, CTAs, navigation links and feature descriptions have one owner;
- no reviewer-only control or private artifact appears in public output.
