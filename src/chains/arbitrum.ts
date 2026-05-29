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
    startBlock: 204751436, // verified: tx 0xede8f4305385f5df63d5221d1377380724c11781000b30a29cf636241abaa59f (cowprotocol/composable-cow networks.json + arbiscan)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // CREATE2 — same across chains
    startBlock: 358667546, // verified: tx 0x97b8fa7baf78bca1836e6a7cdce3bd0b983fa96352fc168ebf5f24ba63f23a91
  },
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Arbitrum
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Arbitrum AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on Arbiscan
  orderbookApiPath: "arbitrum_one",
};
