import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 1; // ~1s per block on Lens Chain (zkSync-based L2)

export const lens: ChainConfig = {
  name: "lens",
  chainId: SupportedChainId.LENS,
  rpcEnvVar: "LENS_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 3516559, // verified: tx 0x39105403b3b7ee84959807135fbebb1bba1de86f85916295d99ff69617c15ae0 (cowprotocol/composable-cow networks.json + rpc.lens.xyz, 2025-09)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: null, // TODO: confirm CoWShedFactory address on Lens
  gpv2Settlement: null, // TODO: enable once AaveV3AdapterFactory is confirmed on Lens
  flashLoanRouter: null, // TODO: confirm via ROUTER() on Lens AaveV3AdapterFactory
  aaveV3AdapterFactory: null, // TODO: verify on explorer.lens.xyz
  orderbookApiPath: "lens", // TODO: verify CoW Protocol orderbook URL for Lens
};
