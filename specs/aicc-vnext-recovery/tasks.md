# AICC vNext recovery tasks

- [x] **T-001 / FR-001..004 / SC-001..003** — Add durable journal and synthetic
  fault tests. Ownership: `src/control-plane/durable-attempt-journal.mjs`,
  `test/durable-attempt-journal.test.mjs`.
- [ ] **T-002 / later** — Integrate restore v2 candidate. HOLD until T-001 evidence.
- [ ] **T-003 / later** — Run isolated L1 canary and main-diff-zero proof.
- [ ] **T-004 / later** — Prepare live maintenance plan; no automatic apply.
