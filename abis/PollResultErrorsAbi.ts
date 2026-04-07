/**
 * PollResultErrors ABI — custom errors thrown by ComposableCoW handler contracts
 * (TWAP, StopLoss, etc.) that bubble up through getTradeableOrderWithSignature.
 *
 * Source: composable-cow/src/interfaces/IConditionalOrder.sol
 */

export const PollResultErrorsAbi = [
  { type: "error", name: "PollTryNextBlock", inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "PollTryAtBlock",   inputs: [{ name: "blockNumber", type: "uint256" }, { name: "reason", type: "string" }] },
  { type: "error", name: "PollTryAtEpoch",   inputs: [{ name: "timestamp", type: "uint256" }, { name: "reason", type: "string" }] },
  { type: "error", name: "PollNever",        inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "OrderNotValid",    inputs: [{ name: "reason", type: "string" }] },
] as const;

/**
 * Minimal ABI for calling getTradeableOrderWithSignature with automatic PollResultError
 * decoding in viem multicall (include errors so viem can decode the revert reason).
 */
export const GetTradeableOrderWithSignatureAbi = [
  {
    type: "function",
    name: "getTradeableOrderWithSignature",
    inputs: [
      { name: "owner", type: "address" },
      {
        type: "tuple",
        name: "params",
        components: [
          { name: "handler", type: "address" },
          { name: "salt", type: "bytes32" },
          { name: "staticInput", type: "bytes" },
        ],
      },
      { name: "offchainInput", type: "bytes" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [
      {
        type: "tuple",
        name: "order",
        components: [
          { name: "sellToken", type: "address" },
          { name: "buyToken", type: "address" },
          { name: "receiver", type: "address" },
          { name: "sellAmount", type: "uint256" },
          { name: "buyAmount", type: "uint256" },
          { name: "validTo", type: "uint32" },
          { name: "appData", type: "bytes32" },
          { name: "feeAmount", type: "uint256" },
          { name: "kind", type: "bytes32" },
          { name: "partiallyFillable", type: "bool" },
          { name: "sellTokenBalance", type: "bytes32" },
          { name: "buyTokenBalance", type: "bytes32" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    stateMutability: "view",
  },
  ...PollResultErrorsAbi,
] as const;
