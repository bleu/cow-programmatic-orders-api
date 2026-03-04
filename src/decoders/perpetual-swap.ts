import { decodeAbiParameters, type Hex } from "viem";

export interface PerpetualSwapDecodedParams {
  tokenA: string;
  tokenB: string;
  validityBucketSeconds: number;  // uint32
  halfSpreadBps: bigint;
  appData: string;
}

const PERPETUAL_SWAP_ABI = [
  {
    type: "tuple",
    components: [
      { name: "tokenA",                type: "address" },
      { name: "tokenB",                type: "address" },
      { name: "validityBucketSeconds", type: "uint32"  },
      { name: "halfSpreadBps",         type: "uint256" },
      { name: "appData",               type: "bytes32" },
    ],
  },
] as const;

export function decodePerpetualSwapStaticInput(staticInput: Hex): PerpetualSwapDecodedParams {
  const [d] = decodeAbiParameters(PERPETUAL_SWAP_ABI, staticInput);
  return {
    tokenA:                d.tokenA.toLowerCase(),
    tokenB:                d.tokenB.toLowerCase(),
    validityBucketSeconds: d.validityBucketSeconds,
    halfSpreadBps:         d.halfSpreadBps,
    appData:               d.appData,
  };
}
