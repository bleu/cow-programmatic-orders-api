import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 2; // ~2s per block on Avalanche C-Chain

export const avalanche: ChainConfig = {
  name: "avalanche",
  chainId: SupportedChainId.AVALANCHE,
  rpcEnvVar: "AVALANCHE_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 60434336, // verified: tx 0xaa800a7183e8313e11a0024a8fe189770c33aaf8fc1451a3a5c373898e25fefa (snowscan.xyz, 2025-04-17)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Avalanche
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Avalanche
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Avalanche AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on snowscan.xyz
  orderbookApiPath: "avalanche", // TODO: verify CoW Protocol orderbook URL for Avalanche
};
