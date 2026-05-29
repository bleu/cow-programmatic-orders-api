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
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // CREATE2 — same across chains
    startBlock: 25033271, // verified: tx 0xad527499a510773fed02f46787d8ed9190d52fe40997c661353805e2bc056a65
  },
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Linea
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Linea AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on lineascan.build
  orderbookApiPath: "linea", // TODO: verify CoW Protocol orderbook URL for Linea
};
