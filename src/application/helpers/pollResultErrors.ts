/**
 * PollResultErrors parser — converts viem multicall failures into typed PollResult values.
 *
 * ABI definitions have moved to abis/PollResultErrorsAbi.ts (re-exported from here for
 * backward compatibility with blockHandler.ts imports).
 *
 * Reference: composable-cow/src/interfaces/IConditionalOrder.sol
 */

export { GetTradeableOrderWithSignatureAbi as GET_TRADEABLE_ORDER_WITH_ERRORS_ABI } from "../../../abis/PollResultErrorsAbi";

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
 * Falls back to TryNextBlock for any error we can't classify — the handler
 * never crashes on unknown reverts.
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
      // Unknown revert: retry next block rather than marking the order permanently invalid
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
