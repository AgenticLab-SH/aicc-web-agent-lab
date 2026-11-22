# Scroll surface audit

Use this mode when a long page, several routes or a viewport matrix would make manual screenshots slow and
context-heavy. It is a deterministic first pass, not a substitute for inspecting the few frames that contain
real findings.

## Manifest

```json
{
  "title": "Landing and product routes",
  "defaultViewports": [
    { "name": "desktop", "width": 1440, "height": 900 },
    { "name": "mobile", "width": 390, "height": 844, "mobile": true }
  ],
  "targets": [
    {
      "id": "landing",
      "url": "http://192.0.2.1:4173/",
      "waitFor": "main",
      "contentPolicy": "public",
      "maxStops": 16
    },
    {
      "id": "workspace",
      "url": "http://192.0.2.1:4173/workspace/",
      "scrollSelector": "[data-workspace-scroll]",
      "contentPolicy": "private"
    }
  ]
}
```

- `contentPolicy: public` permits short visible copy snippets and inflated-copy heuristics in the local report.
  The default `private` records selectors and geometry without page text.
- Use `scrollSelector` only when the app scrolls an inner shell instead of the document.
- Keep one target to one stable page state. Exercise interactions with the scenario runner first, then audit
  the resulting route separately when needed.
- One run accepts at most 24 targets, four viewports per target and 24 scroll stops per viewport.

## Reading the result

- Start with `report.json`; it has counts, route facts and the exact tile that first exposed each finding.
- Open `report.html` only to compare hierarchy and rhythm. It references local tiles and holds no session.
- Inspect frames with `error` findings before warnings. A heuristic remains a candidate until the frame and DOM
  prove it.
- `fixed-overlap`, `clipped-text`, horizontal overflow and runtime failures block publication. Small targets,
  reduced-motion activity, font drift and inflated copy require design judgment.
- Run the same manifest after a change. Keep the old report only when it is useful as a rollback baseline.

The runner uses an isolated Chromium profile and public Playwright/CDP-style browser primitives. It does not
reuse signed-in profiles, submit forms, click controls, accept credentials or mutate a product.
