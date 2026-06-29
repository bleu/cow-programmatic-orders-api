import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 12; // ~12s per block on Sepolia (same as mainnet)

export const sepolia: ChainConfig = {
  name: "sepolia",
  chainId: SupportedChainId.SEPOLIA,
  rpcEnvVar: "SEPOLIA_RPC_URL",
  wsRpcEnvVar: "SEPOLIA_WS_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 5072748, // verified: tx 0xed9625240dec4803ea76358bcac3d4c8678b81a6ffddd50c0326c12626d3f38e (cowprotocol/composable-cow networks.json + sepolia.etherscan.io, 2024-01-12)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // CREATE2 — same across chains
    startBlock: 8784028, // verified: tx 0x4d42972f24fa0846523513e7733b1d2238d0a709c3e4a2cd415cc64885bd1762
  },
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Sepolia
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Sepolia AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on Sepolia
  orderbookApiPath: "sepolia",
};
