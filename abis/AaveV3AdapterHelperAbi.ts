// Minimal interface for Aave CoW adapter helper contracts (per-user proxy instances).
// Shared base: AaveV3BaseAdapter. Three implementation types:
//   RepayWithCollateralAaveV3Adapter: 0xac27f3f86e78b14721d07c4f9ce999285f9aaa06
//   CollateralSwapAaveV3Adapter:      0x029d584e847373b6373b01dfad1a0c9bfb916382
//   DebtSwapAaveV3Adapter:            0x73e7af13ef172f13d8fefebfd90c7a6530096344
//
// Detection: call FACTORY() — if it returns 0xdeCc46a4b09162f5369c5c80383aaa9159bcf192,
//            the address is an Aave adapter.
// EOA resolution: call owner() — returns the EOA directly (1-hop, no deeper chain).
export const AaveV3AdapterHelperAbi = [
  // --- Shared base (AaveV3BaseAdapter) ---
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "FACTORY",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "AAVE_POOL",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "SETTLEMENT_CONTRACT",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getHookData",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct DataTypes.HookOrderData",
        components: [
          { name: "owner", type: "address", internalType: "address" },
          { name: "receiver", type: "address", internalType: "address" },
          { name: "sellToken", type: "address", internalType: "address" },
          { name: "buyToken", type: "address", internalType: "address" },
          { name: "sellAmount", type: "uint256", internalType: "uint256" },
          { name: "buyAmount", type: "uint256", internalType: "uint256" },
          { name: "kind", type: "bytes32", internalType: "bytes32" },
          { name: "validTo", type: "uint256", internalType: "uint256" },
          { name: "flashLoanAmount", type: "uint256", internalType: "uint256" },
          { name: "flashLoanFeeAmount", type: "uint256", internalType: "uint256" },
          { name: "hookSellTokenAmount", type: "uint256", internalType: "uint256" },
          { name: "hookBuyTokenAmount", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isValidSignature",
    inputs: [
      { name: "_orderHash", type: "bytes32", internalType: "bytes32" },
      { name: "_signature", type: "bytes", internalType: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4", internalType: "bytes4" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setParameters",
    inputs: [
      {
        name: "hookData_",
        type: "tuple",
        internalType: "struct DataTypes.HookOrderData",
        components: [
          { name: "owner", type: "address", internalType: "address" },
          { name: "receiver", type: "address", internalType: "address" },
          { name: "sellToken", type: "address", internalType: "address" },
          { name: "buyToken", type: "address", internalType: "address" },
          { name: "sellAmount", type: "uint256", internalType: "uint256" },
          { name: "buyAmount", type: "uint256", internalType: "uint256" },
          { name: "kind", type: "bytes32", internalType: "bytes32" },
          { name: "validTo", type: "uint256", internalType: "uint256" },
          { name: "flashLoanAmount", type: "uint256", internalType: "uint256" },
          { name: "flashLoanFeeAmount", type: "uint256", internalType: "uint256" },
          { name: "hookSellTokenAmount", type: "uint256", internalType: "uint256" },
          { name: "hookBuyTokenAmount", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "rescueTokens",
    inputs: [
      { name: "token", type: "address", internalType: "contract IERC20" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // RepayWithCollateralAaveV3Adapter only:
  {
    type: "function",
    name: "repayDebtWithFlashLoan",
    inputs: [
      {
        name: "erc20Permit",
        type: "tuple",
        internalType: "struct DataTypes.Permit",
        components: [
          { name: "token", type: "address", internalType: "address" },
          { name: "value", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
          { name: "v", type: "uint8", internalType: "uint8" },
          { name: "r", type: "bytes32", internalType: "bytes32" },
          { name: "s", type: "bytes32", internalType: "bytes32" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // DebtSwapAaveV3Adapter only:
  {
    type: "function",
    name: "debtSwapWithFlashLoan",
    inputs: [
      {
        name: "creditDelegationSig",
        type: "tuple",
        internalType: "struct DataTypes.Permit",
        components: [
          { name: "token", type: "address", internalType: "address" },
          { name: "value", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
          { name: "v", type: "uint8", internalType: "uint8" },
          { name: "r", type: "bytes32", internalType: "bytes32" },
          { name: "s", type: "bytes32", internalType: "bytes32" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
