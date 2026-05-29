import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { pollerInterval, type ChainConfig } from "./types";

const blockTime = 12; // ~12s per block on Sepolia (same as mainnet)

export const sepolia: ChainConfig = {
  name: "sepolia",
  chainId: SupportedChainId.SEPOLIA,
  rpcEnvVar: "SEPOLIA_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 5072748, // verified: tx 0xed9625240dec4803ea76358bcac3d4c8678b81a6ffddd50c0326c12626d3f38e (cowprotocol/composable-cow networks.json + sepolia.etherscan.io, 2024-01-12)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Sepolia
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Sepolia
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Sepolia AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on Sepolia
  contractPollerInterval: pollerInterval(blockTime),
  orderbookApiUrl: "https://api.cow.fi/sepolia",
};
