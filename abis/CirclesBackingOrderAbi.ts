// Minimal interface for CirclesBackingOrder handler (Gnosis only).
// Source: aboutcircles/circles-lbp — src/CirclesBackingOrder.sol
// Verified bytecode: 0x43866c5602b0e3b3272424396e88b849796dc608 (chain 100, Sourcify full match).
// ABI entries below are copied verbatim from the Sourcify-verified contract metadata.
//
// SELL_TOKEN and SELL_AMOUNT are constructor immutables — read once per handler
// address via eth_call from the ConditionalOrderCreated event handler.
export const CirclesBackingOrderAbi = [
  {
    inputs: [],
    name: "SELL_TOKEN",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "SELL_AMOUNT",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
