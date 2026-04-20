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
    "The underlying EOA behind the order. Resolved through ownerMapping when owner is a proxy. Null transiently if the mapping hasn't been indexed yet.",
  "conditionalOrderGenerator.handler":
    "The IConditionalOrder handler contract address. Determines the order type.",
  "conditionalOrderGenerator.salt":
    "bytes32 salt used in the order params tuple.",
  "conditionalOrderGenerator.staticInput":
    "ABI-encoded handler parameters. Decoded into decodedParams.",
  "conditionalOrderGenerator.hash":
    "keccak256(abi.encode(handler, salt, staticInput)). Matches the on-chain singleOrders(owner, hash) key.",
  "conditionalOrderGenerator.orderType":
    "One of TWAP, StopLoss, PerpetualSwap, GoodAfterTime, TradeAboveThreshold, Unknown. Derived from the handler address.",
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
    "Next block the C1 poller should check this generator. Internal scheduling field.",
  "conditionalOrderGenerator.lastCheckBlock":
    "Last block where C1 polled this generator.",
  "conditionalOrderGenerator.lastPollResult":
    "Result of the last C1 poll (e.g. success, cancelled:SingleOrderNotAuthed, error:...). Useful for debugging.",
  "conditionalOrderGenerator.nextCheckTimestamp":
    "For orders returning PollTryAtEpoch, the unix timestamp to wait for before the next poll.",

  ...generatePageDocs("conditionalOrderGenerator", "conditional order generator"),
  ...generateQueryDocs("conditionalOrderGenerator", "conditional order generator"),
};
