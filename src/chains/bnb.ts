import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 3; // ~3s per block on BNB Chain

export const bnb: ChainConfig = {
  name: "bnb",
  chainId: SupportedChainId.BNB,
  rpcEnvVar: "BNB_RPC_URL",
  wsRpcEnvVar: "BNB_WS_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 48433175, // verified: tx 0x6595bc3c236157c5a164eb37267486b3c2f6eee02d2e6d9068550e939b18ed71 (cowprotocol/composable-cow networks.json + bscscan.com, 2025-04-17)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // CREATE2 — same across chains
    startBlock: 61362362, // verified: tx 0x76d25671fd1c31044a6cf481df15649fc3503cf5a492de92be8601fee02e259f
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 68412820, // AaveV3AdapterFactory deployment block on BNB
  },
  flashLoanRouter: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on BNB AaveV3AdapterFactory
  aaveV3AdapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
  orderbookApiPath: "bnb", // TODO: verify CoW Protocol orderbook URL for BNB
};
