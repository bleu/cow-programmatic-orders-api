import { decodeAbiParameters, type Hex } from "viem";

// Source: balancer/balancer-v3-monorepo —
//   pkg/standalone-utils/contracts/ERC4626CowSwapFeeBurner.sol (inherits CowSwapFeeBurner.sol)
// Verified on Sourcify at chain 100, address 0x5915dea04ce390f0f44ca0806f7c6dd99ce2f941.
//
// staticInput is non-standard — a bare `abi.encode(address tokenIn)` rather than a tuple.
// The rest of the order (tokenOut, receiver, minAmountOut, deadline) lives in the contract's
// _orders mapping and is NOT recoverable from staticInput; decoding only recovers tokenIn.
// Indexing the fee-burner's OrderCreated event to recover the remaining fields is a larger
// separate task.
//
// Non-deterministic: sellAmount = tokenIn.balanceOf(address(this)) at query time;
// partiallyFillable=true means sellAmount decreases across fills.
export interface Erc4626CowSwapFeeBurnerDecodedParams {
  tokenIn: string;
}

export function decodeErc4626CowSwapFeeBurnerStaticInput(
  staticInput: Hex,
): Erc4626CowSwapFeeBurnerDecodedParams {
  const [tokenIn] = decodeAbiParameters(
    [{ name: "tokenIn", type: "address" }] as const,
    staticInput,
  );
  return { tokenIn: tokenIn.toLowerCase() };
}
