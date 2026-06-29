import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";

const blockTime = 5;

export const gnosis: ChainConfig = {
  name: "gnosis",
  chainId: SupportedChainId.GNOSIS_CHAIN,
  rpcEnvVar: "GNOSIS_RPC_URL",
  blockTime,
  composableCow: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
    startBlock: 29389123,
  },
  composableCowLive: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  },
  cowShedFactory: {
    address: [
      "0x4f4350bf2c74aacd508d598a1ba94ef84378793d", // current (CoWShedForComposableCoW)
      "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // legacy (COWShed); 2 historical events
    ] as const,
    startBlock: 41469991, // earliest COWShedBuilt from either factory on Gnosis
  },
  gpv2Settlement: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
    startBlock: 43177077, // AaveV3AdapterFactory deployment block on Gnosis
  },
  flashLoan: {
    router: "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69", // confirmed via ROUTER() on Gnosis AaveV3AdapterFactory
    adapterFactory: "0xdeCc46a4b09162f5369c5c80383aaa9159bcf192", // verified on Gnosisscan
  },
  orderbookApiPath: "xdai",
};
