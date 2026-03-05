---
linear_id: COW-718
linear_url: https://linear.app/bleu-builders/issue/COW-718/milestone-1-validation-and-testing
status: Todo
linear_synced: true
created: 2026-02-27
milestone: M1
sprint: S2
priority: 2
estimate: 1
depends_on: [COW-713, COW-714, COW-715, COW-716, COW-717]
---

# Milestone 1 Validation & Testing

## Problem

Before declaring M1 complete, we need end-to-end verification that all deliverables work correctly. This includes historical indexing completeness, real-time event detection, decoder accuracy, and GraphQL API functionality.

This task ensures we meet the grant's M1 requirements and are ready for the technical review with Anxo.

## Scope

- [ ] Verify historical indexing completeness on all chains
- [ ] Verify real-time event detection
- [ ] Verify all 5 order types decode correctly
- [ ] Verify GraphQL queries return expected data
- [ ] Performance check: indexing speed, query latency
- [ ] Prepare M1 demo/summary for review

## Technical Details

### Historical Indexing Verification

Compare indexed data against known sources:

```typescript
// Verification queries
const verificationChecks = [
  {
    name: "Total mainnet orders",
    query: `SELECT COUNT(*) FROM conditional_order_generator WHERE chain_id = 1`,
    expectedMin: 1000, // Adjust based on known data
  },
  {
    name: "TWAP orders exist",
    query: `SELECT COUNT(*) FROM conditional_order_generator WHERE order_type = 'TWAP'`,
    expectedMin: 100,
  },
  {
    name: "PoC perpetual swap indexed",
    query: `SELECT * FROM conditional_order_generator WHERE hash = '0x...'`, // From PoC example
    expectedRows: 1,
  },
];
```

### Real-Time Event Detection

1. Monitor logs during indexing
2. If possible, create a test order on testnet
3. Verify order appears in database within seconds

### Decoder Verification

For each order type, verify against known on-chain data:

| Order Type | Test Order | Verification |
|------------|------------|--------------|
| TWAP | Find known TWAP order | Compare decoded params with explorer |
| Stop Loss | Find known Stop Loss order | Compare decoded params |
| Perpetual Swap | PoC example order | Compare with PoC decoded data |
| Good After Time | Find or mock | Verify struct parsing |
| Trade Above Threshold | Find or mock | Verify struct parsing |

### GraphQL API Verification

Test all documented query patterns:

```bash
# List orders for known owner
curl -X POST http://localhost:42069/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ conditionalOrderGenerators(where: { owner: \"0x...\" }) { items { eventId orderType } } }"}'

# Get order by ID
curl -X POST http://localhost:42069/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ conditionalOrderGenerator(chainId: 1, eventId: \"...\") { eventId owner decodedParams } }"}'

# Filter by type and chain
curl -X POST http://localhost:42069/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ conditionalOrderGenerators(where: { orderType: \"TWAP\", chainId: 1 }) { items { eventId } } }"}'
```

### Performance Benchmarks

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Historical sync time | < 1 hour per chain | Time from start to caught up |
| Query latency (simple) | < 100ms | GraphQL playground timing |
| Query latency (filtered) | < 500ms | GraphQL with filters |
| Memory usage | < 2GB | Monitor during indexing |

### M1 Demo Preparation

Create a summary document/presentation:

1. **What was built**
   - Ponder indexer with 3-chain support
   - Schema for conditional orders
   - 5 order type decoders
   - GraphQL API

2. **Key metrics**
   - Number of orders indexed per chain
   - Decoder coverage
   - API response times

3. **Known limitations**
   - Any gaps in decoder coverage
   - Performance considerations
   - Items deferred to M2/M3

4. **Demo queries**
   - Show live GraphQL queries
   - Demonstrate decoded order data

### Checklist for Grant M1 Deliverables

From grant proposal:
- [x] Ponder indexer setup with PostgreSQL database
- [ ] Event listening for Composable CoW order creation and cancellation
- [ ] Historical backfilling and real-time monitoring
- [ ] Decoders for all five order types (implemented locally; cow-sdk integration was removed from grant scope per forum Update #2)

## Acceptance Criteria

- [ ] All historical orders indexed (compare with external source)
- [ ] Real-time events captured within seconds
- [ ] All 5 decoders produce valid output
- [ ] GraphQL queries work as documented
- [ ] No critical performance issues
- [ ] M1 summary document prepared
- [ ] Ready for Anxo technical review

## Open Questions

- [ ] What's the source of truth for "all historical orders"?
- [ ] Can we get testnet access for real-time testing?
- [ ] What format does Anxo prefer for the review?

## References

- Grant Proposal M1: `thoughts/reference_docs/grant_proposal.md`
- Sprint Plan S2.3: `thoughts/plans/sprint_plan.md`
- Grant-Aligned Summary: `thoughts/reference_docs/grant_aligned_summary.md`
