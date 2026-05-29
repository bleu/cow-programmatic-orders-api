import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { pollerInterval, type ChainConfig } from "./types";

const blockTime = 2; // ~2s per block on Base

export const base: ChainConfig = {
  name: "base",
  chainId: SupportedChainId.BASE,
  rpcEnvVar: "BASE_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 15_000_000, // TODO: verify exact ComposableCow deployment block on Base
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Base
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Base
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Base AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on Basescan
  contractPollerInterval: pollerInterval(blockTime),
  orderbookApiUrl: "https://api.cow.fi/base",
};
