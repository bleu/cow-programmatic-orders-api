import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { pollerInterval, type ChainConfig } from "./types";

const blockTime = 2; // ~2s per block on Ink Chain (OP-based L2)

export const ink: ChainConfig = {
  name: "ink",
  chainId: SupportedChainId.INK,
  rpcEnvVar: "INK_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 0, // TODO: verify ComposableCow deployment block on Ink (check explorer.inkonchain.com)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Ink
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Ink
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Ink AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on explorer.inkonchain.com
  contractPollerInterval: pollerInterval(blockTime),
  orderbookApiUrl: "https://api.cow.fi/ink", // TODO: verify CoW Protocol orderbook URL for Ink
};
