import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 3; // ~3s per block on Linea

export const linea: ChainConfig = {
  name: "linea",
  chainId: SupportedChainId.LINEA,
  rpcEnvVar: "LINEA_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 25028474, // verified: tx 0x61f2e7ecec07f7b5c93d491f460cca41eba991fbb022f6866ee17510c9e61151 (cowprotocol/composable-cow networks.json + lineascan.build)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Linea
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Linea
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Linea AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on lineascan.build
  orderbookApiPath: "linea", // TODO: verify CoW Protocol orderbook URL for Linea
};
