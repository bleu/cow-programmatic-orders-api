import { decodeAbiParameters, type Hex } from "viem";

export interface TwapDecodedParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  partSellAmount: bigint;
  minPartLimit: bigint;
  t0: bigint;       // start epoch (0 = at mining time)
  n: bigint;        // number of parts
  t: bigint;        // seconds between parts
  span: bigint;     // part validity duration (0 = fill interval)
  appData: string;  // bytes32
}

const TWAP_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",      type: "address" },
      { name: "buyToken",       type: "address" },
      { name: "receiver",       type: "address" },
      { name: "partSellAmount", type: "uint256" },
      { name: "minPartLimit",   type: "uint256" },
      { name: "t0",             type: "uint256" },
      { name: "n",              type: "uint256" },
      { name: "t",              type: "uint256" },
      { name: "span",           type: "uint256" },
      { name: "appData",        type: "bytes32" },
    ],
  },
] as const;

export function decodeTwapStaticInput(staticInput: Hex): TwapDecodedParams {
  const [d] = decodeAbiParameters(TWAP_ABI, staticInput);
  return {
    sellToken:      d.sellToken.toLowerCase(),
    buyToken:       d.buyToken.toLowerCase(),
    receiver:       d.receiver.toLowerCase(),
    partSellAmount: d.partSellAmount,
    minPartLimit:   d.minPartLimit,
    t0:             d.t0,
    n:              d.n,
    t:              d.t,
    span:           d.span,
    appData:        d.appData,
  };
}
