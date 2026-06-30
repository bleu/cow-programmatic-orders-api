import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 2; // ~2s per block on Avalanche C-Chain

export const avalanche: ChainConfig = {
  name: "avalanche",
  chainId: SupportedChainId.AVALANCHE,
  rpcEnvVar: "AVALANCHE_RPC_URL",
  wsRpcEnvVar: "AVALANCHE_WS_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 60434336, // verified: tx 0xaa800a7183e8313e11a0024a8fe189770c33aaf8fc1451a3a5c373898e25fefa (snowscan.xyz, 2025-04-17)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // CREATE2 — same across chains
    startBlock: 65617025, // verified: tx 0xcf5f0c9a40d26d09e497a6ce871df31ca13d8e72b1724d8ba015368cf36068f1
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 72063515, // AaveV3AdapterFactory deployment block on Avalanche
  },
  flashLoanRouter: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on Avalanche AaveV3AdapterFactory
  aaveV3AdapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
  orderbookApiPath: "avalanche", // TODO: verify CoW Protocol orderbook URL for Avalanche
};
