import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 1; // ~0.25s avg; use 1s as a conservative estimate for polling math

export const arbitrum: ChainConfig = {
  name: "arbitrum",
  chainId: SupportedChainId.ARBITRUM_ONE,
  rpcEnvVar: "ARBITRUM_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 162066830, // TODO: verify exact ComposableCow deployment block on Arbitrum
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Arbitrum
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Arbitrum
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Arbitrum AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on Arbiscan
  orderbookApiPath: "arbitrum_one",
};
