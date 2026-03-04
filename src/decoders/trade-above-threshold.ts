import { decodeAbiParameters, type Hex } from "viem";

export interface TradeAboveThresholdDecodedParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  validityBucketSeconds: number;  // uint32
  threshold: bigint;
  appData: string;
}

const TRADE_ABOVE_THRESHOLD_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",             type: "address" },
      { name: "buyToken",              type: "address" },
      { name: "receiver",              type: "address" },
      { name: "validityBucketSeconds", type: "uint32"  },
      { name: "threshold",             type: "uint256" },
      { name: "appData",               type: "bytes32" },
    ],
  },
] as const;

export function decodeTradeAboveThresholdStaticInput(
  staticInput: Hex
): TradeAboveThresholdDecodedParams {
  const [d] = decodeAbiParameters(TRADE_ABOVE_THRESHOLD_ABI, staticInput);
  return {
    sellToken:             d.sellToken.toLowerCase(),
    buyToken:              d.buyToken.toLowerCase(),
    receiver:              d.receiver.toLowerCase(),
    validityBucketSeconds: d.validityBucketSeconds,
    threshold:             d.threshold,
    appData:               d.appData,
  };
}
