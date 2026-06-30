import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 2; // ~2s per block on Polygon

export const polygon: ChainConfig = {
  name: "polygon",
  chainId: SupportedChainId.POLYGON,
  rpcEnvVar: "POLYGON_RPC_URL",
  wsRpcEnvVar: "POLYGON_WS_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 70406888, // verified: tx 0xef1fdc60092220b9137d2b23189499d995119c281cad648710ac3636bbebf17a (polygonscan.com, 2025-04-17)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // CREATE2 — same across chains
    startBlock: 74072686, // verified: tx 0x9d877eaa06776c30a409fc31db365e8441f982598586345d53ffaee4f9d2da6d
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 79103055, // AaveV3AdapterFactory deployment block on Polygon
  },
  flashLoanRouter: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on Polygon AaveV3AdapterFactory
  aaveV3AdapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
  orderbookApiPath: "polygon", // TODO: verify CoW Protocol orderbook URL for Polygon
};
