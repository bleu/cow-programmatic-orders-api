import {
  DocMap,
  generatePageDocs,
  generateQueryDocs,
} from "ponder-enrich-gql-docs-middleware";

export const flashLoanOrderDocs: DocMap = {
  flashLoanOrder:
    "A standalone CoW Protocol order settled through GPv2Settlement by an Aave V3 flash-loan adapter (not a ComposableCoW conditional order). Recorded executed-only from the on-chain Trade event. adapter <-> order is 1:1.",
  "flashLoanOrder.orderUid": "CoW Protocol order UID. PK part with chainId.",
  "flashLoanOrder.chainId": "EVM chain where the order settled.",
  "flashLoanOrder.adapter":
    "Per-order Aave V3 adapter contract. Indexed; joins to ownerMapping via (chainId, address).",
  "flashLoanOrder.sellToken": "Sell token address.",
  "flashLoanOrder.buyToken": "Buy token address.",
  "flashLoanOrder.executedSellAmount": "Settled sell amount (uint256 decimal string).",
  "flashLoanOrder.executedBuyAmount": "Settled buy amount (uint256 decimal string).",
  "flashLoanOrder.feeAmount": "Fee amount (uint256 decimal string).",
  "flashLoanOrder.validTo":
    "Unix seconds (UTC) when the order expires, decoded from the order UID. JSON number. See docs/api-reference.md#timestamp-fields.",
  "flashLoanOrder.owner":
    "Resolved EOA owner, from the adapter's owner() call (durable on-chain state). Null only if that read failed at settlement.",
  "flashLoanOrder.receiver":
    "Order receiver, from the orderbook. Null until FlashLoanOrderEnricher fills it.",
  "flashLoanOrder.kind":
    "CoW order kind (sell/buy), from the orderbook. Null until enriched.",
  "flashLoanOrder.sellAmountIntended":
    "Signed sell amount, from the orderbook (decimal string). Compare with executedSellAmount for partial fills. Null until enriched.",
  "flashLoanOrder.buyAmountIntended":
    "Signed buy amount, from the orderbook (decimal string). Null until enriched.",
  "flashLoanOrder.source": "Integration the order came from. Currently always 'aave'.",
  "flashLoanOrder.type":
    "Adapter operation derived from the EIP-1167 implementation address: RepayWithCollateral, CollateralSwap, or DebtSwap. Nullable.",
  "flashLoanOrder.enrichedAt":
    "Block time (Unix seconds, BigInt scalar) when orderbook enrichment succeeded. Null while the order is still pending enrichment.",
  "flashLoanOrder.enrichmentAttempts":
    "Number of orderbook enrichment lookups that returned nothing for this order. Internal retry counter.",
  "flashLoanOrder.blockNumber": "Settlement block number (BigInt scalar).",
  "flashLoanOrder.blockTimestamp":
    "Settlement block time, Unix seconds (UTC), BigInt scalar. See docs/api-reference.md#timestamp-fields.",
  "flashLoanOrder.transaction": "The settlement transaction this order belongs to.",
  "flashLoanOrder.ownerMapping": "The adapter -> EOA mapping, joined via the adapter address.",

  ...generatePageDocs("flashLoanOrder", "flash loan order"),
  ...generateQueryDocs("flashLoanOrder", "flash loan order"),
};
