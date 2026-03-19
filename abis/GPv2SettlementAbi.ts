// GPv2Settlement — mainnet: 0x9008D19f58AAbD9eD0D60971565AA8510560ab41
// Start block: 12593265 (May 2021)
// For M2 indexing, consider starting from block 17883049 (ComposableCoW genesis)
// to limit initial sync time.
export const GPv2SettlementAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "authenticator_", type: "address", internalType: "contract GPv2Authentication" },
      { name: "vault_", type: "address", internalType: "contract IVault" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "receive",
    stateMutability: "payable",
  },
  // --- Events ---
  {
    type: "event",
    name: "Trade",
    inputs: [
      { name: "owner", type: "address", indexed: true, internalType: "address" },
      { name: "sellToken", type: "address", indexed: false, internalType: "contract IERC20" },
      { name: "buyToken", type: "address", indexed: false, internalType: "contract IERC20" },
      { name: "sellAmount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "buyAmount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "feeAmount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "orderUid", type: "bytes", indexed: false, internalType: "bytes" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Settlement",
    inputs: [
      { name: "solver", type: "address", indexed: true, internalType: "address" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Interaction",
    inputs: [
      { name: "target", type: "address", indexed: true, internalType: "address" },
      { name: "value", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "selector", type: "bytes4", indexed: false, internalType: "bytes4" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OrderInvalidated",
    inputs: [
      { name: "owner", type: "address", indexed: true, internalType: "address" },
      { name: "orderUid", type: "bytes", indexed: false, internalType: "bytes" },
    ],
    anonymous: false,
  },
  // --- Functions ---
  {
    type: "function",
    name: "settle",
    inputs: [
      { name: "tokens", type: "address[]", internalType: "contract IERC20[]" },
      { name: "clearingPrices", type: "uint256[]", internalType: "uint256[]" },
      {
        name: "trades",
        type: "tuple[]",
        internalType: "struct GPv2Trade.Data[]",
        components: [
          { name: "sellTokenIndex", type: "uint256", internalType: "uint256" },
          { name: "buyTokenIndex", type: "uint256", internalType: "uint256" },
          { name: "receiver", type: "address", internalType: "address" },
          { name: "sellAmount", type: "uint256", internalType: "uint256" },
          { name: "buyAmount", type: "uint256", internalType: "uint256" },
          { name: "validTo", type: "uint32", internalType: "uint32" },
          { name: "appData", type: "bytes32", internalType: "bytes32" },
          { name: "feeAmount", type: "uint256", internalType: "uint256" },
          { name: "flags", type: "uint256", internalType: "uint256" },
          { name: "executedAmount", type: "uint256", internalType: "uint256" },
          { name: "signature", type: "bytes", internalType: "bytes" },
        ],
      },
      {
        name: "interactions",
        type: "tuple[3][]",
        internalType: "struct GPv2Interaction.Data[][3]",
        components: [
          { name: "target", type: "address", internalType: "address" },
          { name: "value", type: "uint256", internalType: "uint256" },
          { name: "callData", type: "bytes", internalType: "bytes" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "invalidateOrder",
    inputs: [
      { name: "orderUid", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "filledAmount",
    inputs: [
      { name: "", type: "bytes", internalType: "bytes" },
    ],
    outputs: [
      { name: "", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "authenticator",
    inputs: [],
    outputs: [
      { name: "", type: "address", internalType: "contract GPv2Authentication" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "vault",
    inputs: [],
    outputs: [
      { name: "", type: "address", internalType: "contract IVault" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "vaultRelayer",
    inputs: [],
    outputs: [
      { name: "", type: "address", internalType: "contract GPv2VaultRelayer" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "freeFilledAmountStorage",
    inputs: [
      { name: "orderUids", type: "bytes[]", internalType: "bytes[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "freePreSignatureStorage",
    inputs: [
      { name: "orderUids", type: "bytes[]", internalType: "bytes[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
