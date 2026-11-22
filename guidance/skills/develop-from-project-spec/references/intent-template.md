# Change intent template

Use this template for `<git-root>/specs/<change>/intent.md`. It captures the owner's goal and boundaries before detailed requirements or implementation choices.

```markdown
# <Change> intent

- ID: INT-<stable-id>
- Status: draft
- Owner: <person or accountable role>
- Target: <product, repository, or coordinated repositories>
- Supersedes: <older intent path or none>

## Problem

What is wrong, missing, slow, unsafe, or unclear today?

## Evidence

- <observed user report, product behavior, test, metric, or authoritative source>

## Desired outcome

What should be observably better when this intent is delivered? Avoid architecture or file choices.

## Affected users and systems

- Users: <who experiences the problem or outcome>
- Systems: <products, repositories, services, or external surfaces in scope>

## Constraints

- <security, compatibility, policy, time, data, recovery, or authority boundary>

## Out of scope

- <explicit non-goal>

## Success signals

- <observable behavior or metric that would show the outcome exists>

## Open questions

- <question> — owner: <person/task> — resolve before: <acceptance/spec/implementation/delivery>
- If none, write `None` rather than deleting this section.

## Decision

- <draft pending review, or accepted/rejected/superseded decision with the deciding owner and reason>
```

Lifecycle:

```text
draft -> accepted -> delivered
  |          |
  +-> rejected
  +-> superseded
```

If the user changes the outcome or boundary, update the decision and the affected scope. Record unresolved choices as draft; keep the parts already explicitly approved. A wording-only correction does not revoke approval. Do not add raw transcripts, secrets, or generated logs. This separate template is optional; an existing concise specification can own the same information.
