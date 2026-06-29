import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

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
  cowShedFactory: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // CREATE2 — same across chains
    startBlock: 4803028, // verified: tx 0x33d7ed32d433467d75373baf0bcbc99fec65df8a8fd6f67673efa8378f67ebcc
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 7830693, // AaveV3AdapterFactory deployment block on Plasma
  },
  flashLoan: {
    router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // verified: ROUTER() on Plasma AaveV3AdapterFactory
    adapterFactory: "0xdeCC46a4b09162F5369c5C80383AAa9159bCf192", // CREATE2 — same across chains
  },
  orderbookApiPath: "plasma", // TODO: verify CoW Protocol orderbook URL for Plasma
  orderbookPollInterval: 20, // ~20 blocks at 1s/block (prior global cadence)
};
