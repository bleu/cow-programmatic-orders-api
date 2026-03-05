import { decodeAbiParameters, type Hex } from "viem";

export interface GoodAfterTimeDecodedParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: bigint;
  minSellBalance: bigint;
  startTime: bigint;
  endTime: bigint;
  allowPartialFill: boolean;
  priceCheckerPayload: string;  // hex bytes — opaque in M1
  appData: string;
}

const GOOD_AFTER_TIME_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",           type: "address" },
      { name: "buyToken",            type: "address" },
      { name: "receiver",            type: "address" },
      { name: "sellAmount",          type: "uint256" },
      { name: "minSellBalance",      type: "uint256" },
      { name: "startTime",           type: "uint256" },
      { name: "endTime",             type: "uint256" },
      { name: "allowPartialFill",    type: "bool"    },
      { name: "priceCheckerPayload", type: "bytes"   },
      { name: "appData",             type: "bytes32" },
    ],
  },
] as const;

export function decodeGoodAfterTimeStaticInput(staticInput: Hex): GoodAfterTimeDecodedParams {
  const [d] = decodeAbiParameters(GOOD_AFTER_TIME_ABI, staticInput);
  return {
    sellToken:           d.sellToken.toLowerCase(),
    buyToken:            d.buyToken.toLowerCase(),
    receiver:            d.receiver.toLowerCase(),
    sellAmount:          d.sellAmount,
    minSellBalance:      d.minSellBalance,
    startTime:           d.startTime,
    endTime:             d.endTime,
    allowPartialFill:    d.allowPartialFill,
    priceCheckerPayload: d.priceCheckerPayload,
    appData:             d.appData,
  };
}
