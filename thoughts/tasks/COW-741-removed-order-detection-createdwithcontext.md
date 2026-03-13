# [DRAFT] M1 feedback: removed order detection + createdWithContext

**Source:** post-M1 delivery feedback (`user-notes-explore-sdk.txt` lines 13–20).

---

## Problem

1. **Remove:** There is no event on ComposableCoW when the user removes an order (`remove(singleOrderHash)`). Our indexer has no way to know that an order is no longer valid.
2. **Context:** Whether the order was created with context (`createdWithContext` / `setRootWithContext`) and what that context value is are not exposed in a way we can index cleanly (via event or existing data).

---

## What to do on our side (task)

- [ ] **Research contract and documentation**
  - Confirm in the ComposableCoW ABI/repo: exact signature of `remove(bytes32 singleOrderHash)` and that **no event** is emitted on removal.
  - Understand the relationship between `singleOrderHash` and the identifiers we index (e.g. `eventId`, conditional order hash, etc.) so we can map “remove” → our table.
  - Check if there is any function/view that tells us whether an order is still “active” (e.g. on-chain check by owner + hash) for use as a fallback (e.g. cron).
- [ ] **Understand createdWithContext**
  - Difference between `setRoot` and `setRootWithContext` in the contract; where “context” is stored and whether it’s accessible via view/event.
  - Whether we already have any indexed data that indicates “created with context” and its value; if not, what we would need (new event, field on existing event, etc.).
- [ ] **Implementation options (after research)**
  - **Option A:** Detect calls to `remove(singleOrderHash)` (e.g. via traces/transactions to ComposableCoW) and mark the corresponding order as removed in our schema. Document whether this is feasible with Ponder/available RPC (e.g. eth_getTransactionReceipt + logs vs internal calls).
  - **Option B:** If we can’t detect remove in real time: cron/periodic job that queries on-chain (or our source of truth) and updates orders that are no longer valid. Define frequency and scope (e.g. mainnet only, last N blocks only).
  - **Option C:** If mfw adds a removal event (and possibly context) to the contract, plan integration of that event into the indexer and, if applicable, deprecate Option A/B or use as fallback.
- [ ] **Schema/API**
  - Decide whether we need field(s) in the schema for “removed” (e.g. `removedAtBlock`, `isRemoved`) and/or for “createdWithContext” and context value, based on research results.
- [ ] **Document**
  - Summarise findings (contract, options, trade-offs) in a short doc under `thoughts/` or `agent_docs/` for future reference and to align with the team/mfw.

---

## References

- `abis/ComposableCowAbi.ts`: event `ConditionalOrderCreated`; function `remove(bytes32 singleOrderHash)`; `setRoot` vs `setRootWithContext`.
- `user-notes-explore-sdk.txt` (lines 13–20): original feedback.
