import { decodeAbiParameters, type Hex } from "viem";

export interface CirclesBackingOrderDecodedParams {
  buyToken: string;
  buyAmount: bigint;
  validTo: number;     // uint32
  appData: string;     // bytes32
}

const CIRCLES_BACKING_ORDER_ABI = [
  {
    type: "tuple",
    components: [
      { name: "buyToken",  type: "address" },
      { name: "buyAmount", type: "uint256" },
      { name: "validTo",   type: "uint32"  },
      { name: "appData",   type: "bytes32" },
    ],
  },
] as const;

export function decodeCirclesBackingOrderStaticInput(
  staticInput: Hex,
): CirclesBackingOrderDecodedParams {
  const [d] = decodeAbiParameters(CIRCLES_BACKING_ORDER_ABI, staticInput);
  return {
    buyToken:  d.buyToken.toLowerCase(),
    buyAmount: d.buyAmount,
    validTo:   d.validTo,
    appData:   d.appData,
  };
}
