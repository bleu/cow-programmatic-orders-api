import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 3; // ~3s per block on BNB Chain

export const bnb: ChainConfig = {
  name: "bnb",
  chainId: SupportedChainId.BNB,
  rpcEnvVar: "BNB_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 48433175, // verified: tx 0x6595bc3c236157c5a164eb37267486b3c2f6eee02d2e6d9068550e939b18ed71 (cowprotocol/composable-cow networks.json + bscscan.com, 2025-04-17)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on BNB
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on BNB
  flashLoanRouter: null, // TODO: confirm via ROUTER() on BNB AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on bscscan.com
  orderbookApiPath: "bnb", // TODO: verify CoW Protocol orderbook URL for BNB
};
