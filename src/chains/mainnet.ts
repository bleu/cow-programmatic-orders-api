import type { ChainConfig } from "./types";

export const mainnet: ChainConfig = {
  name: "mainnet",
  chainId: 1,
  rpcEnvVar: "MAINNET_RPC_URL",
  blockTime: 12,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
    startBlock: 17883049,
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86",
    startBlock: 22939254,
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 23812751, // AaveV3AdapterFactory deployment block (Nov 16, 2025)
  },
  flashLoanRouter: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69",
  aaveV3AdapterFactory: "0xdeCc46a4b09162f5369c5c80383aaa9159bcf192",
  contractPollerInterval: 1,
  orderbookApiUrl: "https://api.cow.fi/mainnet",
};
