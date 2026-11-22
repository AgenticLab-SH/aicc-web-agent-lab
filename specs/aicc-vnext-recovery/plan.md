# AICC vNext recovery plan

1. Add and fault-test the common durable attempt journal.
2. Integrate it with restore v2 status/dry-run/apply/reconcile.
3. Prove L0 and L1 isolated canaries and main-state write diff zero.
4. Only then prepare an exact live maintenance transaction with rollback.

The first batch owns only the new journal module, its tests, and these spec files.
It does not reactivate any AICC runtime.
