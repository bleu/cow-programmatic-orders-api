import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 1; // ~1s per block on Lens Chain (zkSync-based L2)

export const lens: ChainConfig = {
  name: "lens",
  chainId: SupportedChainId.LENS,
  rpcEnvVar: "LENS_RPC_URL",
  wsRpcEnvVar: "LENS_WS_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74", // CREATE2 — same across chains
    startBlock: 3516559, // verified: tx 0x39105403b3b7ee84959807135fbebb1bba1de86f85916295d99ff69617c15ae0 (cowprotocol/composable-cow networks.json + rpc.lens.xyz, 2025-09)
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // CREATE2 — same across chains
    startBlock: 3519249, // verified: tx 0x53df62bc122ecb5bfa9770776bb54b3a81e5f7238e4b02c52ac7000eb36c86bd
  },
  gpv2Settlement: null, // TODO: enable once flash-loan infra is confirmed on Lens
  flashLoan: null, // TODO: set { aaveV3: { router, adapterFactory } } once flash-loan infra is confirmed on Lens
  orderbookApiPath: "lens", // NOTE: api.cow.fi/lens returns 404 — orderbook not live for Lens yet
  orderbookPollInterval: 20 * blockTime,
};
