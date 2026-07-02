import {
  DocMap,
  generatePageDocs,
  generateQueryDocs,
} from "ponder-enrich-gql-docs-middleware";

export const conditionalOrderGeneratorDocs: DocMap = {
  conditionalOrderGenerator:
    "A programmatic order registered on-chain via ComposableCoW.create() or createWithContext(). One row per ConditionalOrderCreated event. Each generator may produce multiple discrete orders over its lifetime.",
  "conditionalOrderGenerator.eventId":
    "Ponder-assigned event identifier. Part of the composite primary key with chainId.",
  "conditionalOrderGenerator.chainId":
    "EVM chain where the order was created. 1 = mainnet, 100 = Gnosis.",
  "conditionalOrderGenerator.owner":
    "Address that created the order on-chain. May be a CoWShed proxy or Aave flash loan adapter rather than the EOA.",
  "conditionalOrderGenerator.resolvedOwner":
    "The underlying EOA for this order, set once at insert time. Equals the mapped EOA if owner is a known CoWShed or Aave adapter at creation time; otherwise equals owner. Not updated retroactively if a proxy mapping is indexed later.",
  "conditionalOrderGenerator.ownerAddressType":
    "Proxy channel through which this order was created. 'flash_loan_helper' = Aave V3 adapter (FACTORY() introspection via settlement handler); 'cowshed_proxy' = CoWShed smart wallet proxy; null = direct EOA, or Aave adapter whose mapping has not yet been discovered (backfilled on first settlement). Distinct from orderType, which describes the handler contract logic — an Aave flash loan can wrap any order type.",
  "conditionalOrderGenerator.handler":
    "The IConditionalOrder handler contract address. Determines the order type.",
  "conditionalOrderGenerator.salt":
    "bytes32 salt used in the order params tuple.",
  "conditionalOrderGenerator.staticInput":
    "ABI-encoded handler parameters. Decoded into decodedParams.",
  "conditionalOrderGenerator.hash":
    "keccak256(abi.encode(handler, salt, staticInput)). Matches the on-chain singleOrders(owner, hash) key.",
  "conditionalOrderGenerator.orderType":
    "One of TWAP, StopLoss, PerpetualSwap, GoodAfterTime, TradeAboveThreshold, CirclesBackingOrder, SwapOrderHandler, ERC4626CowSwapFeeBurner, or Unknown. Derived from the handler address. decodedParams is populated for every value except Unknown (see decodeError for the failure case). Shapes for TWAP, StopLoss, PerpetualSwap, GoodAfterTime, and TradeAboveThreshold are documented in docs/supported-order-types.md; shapes for CirclesBackingOrder, SwapOrderHandler, and ERC4626CowSwapFeeBurner are defined by the decoders in src/decoders/.",
  "conditionalOrderGenerator.status":
    "Active, Cancelled, or Completed. Starts Active. Moves to Cancelled when removed from the contract; moves to Completed when no more discrete orders can be produced.",
  "conditionalOrderGenerator.decodedParams":
    "staticInput decoded as a JSON object. Null if the order type is Unknown or decoding failed. Shape depends on orderType — see docs/supported-order-types.md.",
  "conditionalOrderGenerator.decodeError":
    '"invalid_static_input" when decoding failed, otherwise null.',
  "conditionalOrderGenerator.txHash":
    "Transaction hash where this order was created.",
  "conditionalOrderGenerator.allCandidatesKnown":
    "Whether all possible discrete orders for this generator have been discovered. True for deterministic types (TWAP, StopLoss) after UID precomputation.",
  "conditionalOrderGenerator.nextCheckBlock":
    "Next block the OrderDiscoveryPoller should check this generator. Internal scheduling field.",
  "conditionalOrderGenerator.lastCheckBlock":
    "Last block where OrderDiscoveryPoller polled this generator.",
  "conditionalOrderGenerator.lastPollResult":
    "Result of the last OrderDiscoveryPoller poll (e.g. success, cancelled:SingleOrderNotAuthed, error:...). Useful for debugging.",
  "conditionalOrderGenerator.nextCheckTimestamp":
    "For orders returning PollTryAtEpoch, the epoch to wait for before the next poll. Unix seconds (UTC), decimal string (BigInt scalar). See docs/api-reference.md#timestamp-fields.",
  "conditionalOrderGenerator.historyBackfilled":
    "Whether OwnerBackfill has drained this generator's full /account order history from the CoW Orderbook. Applies to non-deterministic types (PerpetualSwap, GoodAfterTime, etc.) whose discrete orders cannot be precomputed. Internal one-time bootstrap flag.",
  "conditionalOrderGenerator.transaction":
    "The transaction that emitted the ConditionalOrderCreated event. Joined on (chainId, txHash).",
  "conditionalOrderGenerator.discreteOrders":
    "All confirmed CoW Protocol orders produced by this generator. Empty until the first discrete order is confirmed.",
  "conditionalOrderGenerator.candidateDiscreteOrders":
    "Unconfirmed candidates discovered by the OrderDiscoveryPoller block handler that have not been promoted to discreteOrder yet.",

  ...generatePageDocs("conditionalOrderGenerator", "conditional order generator"),
  ...generateQueryDocs("conditionalOrderGenerator", "conditional order generator"),
};
