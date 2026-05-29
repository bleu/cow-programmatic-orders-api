import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 2; // ~2s per block on Polygon

export const polygon: ChainConfig = {
  name: "polygon",
  chainId: SupportedChainId.POLYGON,
  rpcEnvVar: "POLYGON_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 70406888, // verified: tx 0xef1fdc60092220b9137d2b23189499d995119c281cad648710ac3636bbebf17a (polygonscan.com, 2025-04-17)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Polygon
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Polygon
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Polygon AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on polygonscan.com
  orderbookApiPath: "polygon", // TODO: verify CoW Protocol orderbook URL for Polygon
};
