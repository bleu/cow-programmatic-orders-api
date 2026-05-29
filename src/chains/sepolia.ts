import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 12; // ~12s per block on Sepolia (same as mainnet)

export const sepolia: ChainConfig = {
  name: "sepolia",
  chainId: SupportedChainId.SEPOLIA,
  rpcEnvVar: "SEPOLIA_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 4_000_000, // TODO: verify exact ComposableCow deployment block on Sepolia
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Sepolia
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Sepolia
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Sepolia AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on Sepolia
  orderbookApiPath: "sepolia",
};
