// AaveV3AdapterFactory — mainnet: 0xdeCc46a4b09162f5369c5c80383aaa9159bcf192
// Start block: 23812751 (November 16, 2025)
// Note: inherits BaseAdapterFactory (closed source). ABI covers only the confirmed
// public interface of AaveV3AdapterFactory.sol itself.
export const AaveV3AdapterFactoryAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "aavePool_", type: "address", internalType: "address" },
      { name: "settlement_", type: "address", internalType: "address" },
      { name: "router_", type: "address", internalType: "address" },
      { name: "owner_", type: "address", internalType: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "POOL",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "contract IPool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ADDRESSES_PROVIDER",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "contract IPoolAddressesProvider" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "executeOperation",
    inputs: [
      { name: "assets", type: "address[]", internalType: "address[]" },
      { name: "amounts", type: "uint256[]", internalType: "uint256[]" },
      { name: "premiums", type: "uint256[]", internalType: "uint256[]" },
      { name: "initiator", type: "address", internalType: "address" },
      { name: "params", type: "bytes", internalType: "bytes" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "error",
    name: "CallerNotAavePool",
    inputs: [],
  },
] as const;
