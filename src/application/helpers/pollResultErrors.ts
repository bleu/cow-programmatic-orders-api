/**
 * PollResultErrors — ABI definitions and parser for ComposableCoW order lifecycle errors.
 *
 * These custom errors are thrown by handler contracts (TWAP, StopLoss, etc.) and bubble
 * up through ComposableCoW.getTradeableOrderWithSignature. They drive the watch-tower
 * scheduling loop implemented in blockHandler.ts.
 *
 * Source: composable-cow/src/interfaces/IConditionalOrder.sol
 * Reference: agent_docs/decoder-reference.md#PollResultErrors
 */

// ─── ABI ─────────────────────────────────────────────────────────────────────

/**
 * Minimal ABI for getTradeableOrderWithSignature + all PollResultErrors.
 * Used in multicall so viem auto-decodes the revert reasons.
 */
export const GET_TRADEABLE_ORDER_WITH_ERRORS_ABI = [
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
  // PollResultErrors — thrown by handler contracts, surface through getTradeableOrderWithSignature
  { type: "error", name: "PollTryNextBlock", inputs: [{ name: "reason", type: "string" }] },
  { type: "error", name: "PollTryAtBlock",   inputs: [{ name: "blockNumber", type: "uint256" }, { name: "reason", type: "string" }] },
  { type: "error", name: "PollTryAtEpoch",   inputs: [{ name: "timestamp", type: "uint256" }, { name: "reason", type: "string" }] },
  { type: "error", name: "PollNever",        inputs: [{ name: "reason", type: "string" }] },
  // OrderNotValid: order exists but conditions not met yet (treat as TryNextBlock for scheduling)
  { type: "error", name: "OrderNotValid",    inputs: [{ name: "reason", type: "string" }] },
] as const;

// ─── Typed result ─────────────────────────────────────────────────────────────

export type PollResult =
  | { type: "tryNextBlock" }
  | { type: "tryAtBlock"; blockNumber: bigint }
  | { type: "tryAtEpoch"; timestamp: bigint }
  | { type: "never"; reason: string }
  | { type: "success" };

// ─── Error extraction ─────────────────────────────────────────────────────────

/**
 * Extract the PollResult from a viem multicall failure.
 *
 * Viem wraps revert errors as:
 *   ContractFunctionExecutionError
 *     .cause → ContractFunctionRevertedError
 *       .data.errorName  (set when error ABI is known)
 *       .data.args
 *
 * Falls back to TryNextBlock for any error we can't classify.
 */
export function parsePollError(error: unknown): PollResult {
  const decoded = walkCauseChain(error);
  if (!decoded) return { type: "tryNextBlock" };

  switch (decoded.name) {
    case "PollTryNextBlock":
      return { type: "tryNextBlock" };

    case "PollTryAtBlock": {
      const blockNumber = decoded.args[0];
      if (typeof blockNumber === "bigint") return { type: "tryAtBlock", blockNumber };
      return { type: "tryNextBlock" };
    }

    case "PollTryAtEpoch": {
      const timestamp = decoded.args[0];
      if (typeof timestamp === "bigint") return { type: "tryAtEpoch", timestamp };
      return { type: "tryNextBlock" };
    }

    case "PollNever": {
      const reason = decoded.args[0];
      return { type: "never", reason: typeof reason === "string" ? reason : "" };
    }

    case "OrderNotValid":
      // Order not tradeable yet — retry next block (transient)
      return { type: "tryNextBlock" };

    default:
      return { type: "tryNextBlock" };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function walkCauseChain(
  err: unknown,
): { name: string; args: readonly unknown[] } | null {
  // Walk up to 6 levels of .cause to find ContractFunctionRevertedError
  let current = err;
  for (let depth = 0; depth < 6; depth++) {
    if (!current || typeof current !== "object") break;
    const obj = current as Record<string, unknown>;

    // ContractFunctionRevertedError pattern: .data.errorName + .data.args
    if (obj.data && typeof obj.data === "object") {
      const data = obj.data as Record<string, unknown>;
      if (typeof data.errorName === "string") {
        return {
          name: data.errorName,
          args: Array.isArray(data.args) ? data.args : [],
        };
      }
    }

    current = ("cause" in obj) ? obj.cause : null;
  }
  return null;
}
