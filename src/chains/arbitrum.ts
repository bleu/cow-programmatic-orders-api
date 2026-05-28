// Placeholder — addresses not yet confirmed. Enable when Arbitrum indexing is ready.
//
// import type { ChainConfig } from "./types";
//
// export const arbitrum: ChainConfig = {
//   name: "arbitrum",
//   chainId: 42161,
//   rpcEnvVar: "ARBITRUM_RPC_URL",
//   blockTime: 1, // ~0.25s avg, treat as ~1s for polling purposes
//   composableCow: {
//     address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // TODO: confirm CREATE2 address on Arbitrum
//     startBlock: 0, // TODO: set deployment block
//   },
//   composableCowLive: {
//     address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // TODO: confirm
//   },
//   cowShedFactory: {
//     address: "0x...", // TODO: confirm CoWShedFactory address on Arbitrum
//     startBlock: 0, // TODO: set deployment block
//   },
//   gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Arbitrum
//   flashLoanRouter: null, // TODO: confirm via ROUTER() on Arbitrum AaveV3AdapterFactory
//   aaveV3AdapterFactory: null, // TODO: verify on Arbiscan
//   contractPollerInterval: 1,
//   orderbookApiUrl: "https://api.cow.fi/arbitrum_one",
// };
