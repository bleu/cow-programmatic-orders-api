import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 2; // ~2s per block on Base

export const base: ChainConfig = {
  name: "base",
  chainId: SupportedChainId.BASE,
  rpcEnvVar: "BASE_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 21794150, // verified: tx 0xdfa9fded3b1743ce2556a245b17690b073cdd9d59739b60d5e4091e445d732b7 (basescan, 2024-10-31)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // CREATE2 — same across chains
    startBlock: 32986811, // verified: tx 0x29c63a32edbf7b29ae73e6a8e5293b65c65906943ad41092205a473e4bbf56d0
  },
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Base
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Base AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on Basescan
  orderbookApiPath: "base",
};
