# Project-owned DESIGN.md schema

Use only sections supported by actual decisions. Omit empty decorative prose.

```markdown
# Design direction

## Context
- Product:
- Audience:
- Surface mode: persuade | operate | read | experience
- Success condition:
- Status: draft | confirmed

## Frame and adapters
- Frame id/path and version:
- Design layer id/path and version:
- Cross-media invariants:
- Target adapters: web | slides | word | pdf | report | visualization | motion
- Editable and rendered deliverables:

## Direction
- Summary:
- Preserve:
- Replace:
- Anti-references:

## References
| Source | Evidence checked | Adopt | Avoid |
| --- | --- | --- | --- |

## System
- Color roles:
- Typography roles:
- Spacing and density:
- Radius and depth:
- Motion:
- Icon and image language:

## Medium adaptations
- Web:
- Slides/master/layout:
- Word/PDF/report:
- Visualization/diagram:

## Voice and states
- Voice:
- Loading / empty / error / partial / stale / permission / offline:

## Responsive and accessibility
- Content priority by viewport:
- Keyboard and focus:
- Contrast and reduced motion:

## Existing truth
- Components, tokens, assets, and behavior that remain authoritative:

## Unknowns
- UNKNOWN:

## Provenance
- `verified_reference`:
- `existing_truth`:
- `project_decision`:

## Validation
- Source/fact/data:
- Native structure:
- Accessibility and rights:
- Browser/render/export:
- HOLD/UNKNOWN:
```

Keep secrets, authenticated URLs, personal data, raw prompts, browser state, and copied third-party
assets out of this file. A public repository must contain only references and materials safe to share.
Omit the frame/adapters sections for a genuinely single-format project rather than adding empty ceremony.
