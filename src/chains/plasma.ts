import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { pollerInterval, type ChainConfig } from "./types";

const blockTime = 1; // ~1s per block on Plasma (L2)

export const plasma: ChainConfig = {
  name: "plasma",
  chainId: SupportedChainId.PLASMA,
  rpcEnvVar: "PLASMA_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 4810535, // verified: tx 0xa4db8e5f949f39af60460fc05979b363b01570970e94eb8397dc39cfbdcaed86 (cowprotocol/composable-cow networks.json + rpc.plasma.to)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Plasma
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Plasma
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Plasma AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on plasmascan.to
  contractPollerInterval: pollerInterval(blockTime),
  orderbookApiUrl: "https://api.cow.fi/plasma", // verified: api.cow.fi/plasma returns 200 (ORDER_BOOK_PROD_CONFIG in cow-sdk)
};
