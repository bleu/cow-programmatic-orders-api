import {
  DocMap,
  generatePageDocs,
  generateQueryDocs,
} from "ponder-enrich-gql-docs-middleware";

export const discreteOrderDocs: DocMap = {
  discreteOrder:
    "An individual CoW Protocol order produced by a conditional order generator. Represents an actual order placed in the CoW Protocol orderbook.",
  "discreteOrder.orderUid":
    "CoW Protocol order UID. Part of the composite primary key with chainId.",
  "discreteOrder.chainId": "EVM chain where the order was placed.",
  "discreteOrder.conditionalOrderGeneratorId":
    "References the parent generator's eventId.",
  "discreteOrder.status":
    "open (in the orderbook, not yet settled), fulfilled (the order was settled; executedSellAmount and executedBuyAmount are populated), unfilled (left the orderbook without settling), expired (validTo passed without settlement), or cancelled (the orderbook API reported the order as cancelled, or the C5 reconciliation marked it cancelled because its parent generator was removed on-chain). Tracked via the CoW Protocol orderbook API.",
  "discreteOrder.sellAmount":
    "Sell amount requested, as a decimal string (uint256, raw token units).",
  "discreteOrder.buyAmount":
    "Minimum buy amount as a decimal string (uint256).",
  "discreteOrder.feeAmount": "Fee amount as a decimal string (uint256).",
  "discreteOrder.validTo":
    "Unix seconds (UTC) when this order expires. Returned as a JSON number — the CoW protocol encodes validTo as uint32 in the order UID, so the column is t.integer(). Null if not yet known. See docs/api-reference.md#timestamp-fields.",
  "discreteOrder.creationDate":
    "Unix seconds (UTC), decimal string (BigInt scalar). Source depends on discovery path: C4-fetched orders use the orderbook API's order submission timestamp; pre-computed deterministic orders (TWAP, StopLoss) use the generator event's block timestamp; C1-discovered orders use the block timestamp at C1 discovery.",
  "discreteOrder.executedSellAmount":
    "Actual sell amount filled after settlement. Null before the order is fulfilled.",
  "discreteOrder.executedBuyAmount":
    "Actual buy amount received after settlement. Null before the order is fulfilled.",
  "discreteOrder.promotedAt":
    "Unix timestamp (seconds) when C2 promoted this row from candidateDiscreteOrder. Null means the row was created directly without going through the candidate stage (TWAP/StopLoss precomputation at creation time, or C4 historical bootstrap). Non-null means this order was first discovered on-chain by C1 or UID precomputation, held as a candidate until the orderbook API confirmed it (or until it expired).",
  "discreteOrder.conditionalOrderGenerator":
    "The parent generator that produced this discrete order.",

  candidateDiscreteOrder:
    "An unconfirmed discrete order discovered by the C1 block handler via getTradeableOrderWithSignature. Candidates are promoted to discreteOrder once confirmed against the orderbook API.",
  "candidateDiscreteOrder.orderUid": "CoW Protocol order UID.",
  "candidateDiscreteOrder.chainId": "EVM chain ID.",
  "candidateDiscreteOrder.conditionalOrderGeneratorId":
    "References the parent generator's eventId.",
  "candidateDiscreteOrder.sellAmount": "Sell amount as a decimal string.",
  "candidateDiscreteOrder.buyAmount": "Buy amount as a decimal string.",
  "candidateDiscreteOrder.feeAmount": "Fee amount as a decimal string.",
  "candidateDiscreteOrder.validTo":
    "Predicted Unix seconds (UTC) when this candidate would expire if promoted. JSON number (uint32 per CoW protocol). Null when not yet known. See discreteOrder.validTo for the confirmed value and docs/api-reference.md#timestamp-fields for the timestamp policy.",
  "candidateDiscreteOrder.creationDate":
    "Unix seconds (UTC), decimal string (BigInt scalar). Block timestamp at C1 discovery.",
  "candidateDiscreteOrder.possibleValidAfterTimestamp":
    "For TWAP: t0 + partIndex*t. Earliest Unix seconds (UTC) the part can be valid — used to skip orderbook API calls before that timestamp. Decimal string (BigInt scalar).",
  "candidateDiscreteOrder.conditionalOrderGenerator":
    "The parent generator that produced this candidate.",

  ...generatePageDocs("discreteOrder", "discrete order"),
  ...generateQueryDocs("discreteOrder", "discrete order"),
  ...generatePageDocs("candidateDiscreteOrder", "candidate discrete order"),
  ...generateQueryDocs("candidateDiscreteOrder", "candidate discrete order"),
};
