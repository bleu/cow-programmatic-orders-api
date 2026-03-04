import { decodeAbiParameters, type Hex } from "viem";

export interface StopLossDecodedParams {
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  buyAmount: bigint;
  appData: string;
  receiver: string;
  isSellOrder: boolean;
  isPartiallyFillable: boolean;
  validTo: number;               // uint32
  sellTokenPriceOracle: string;  // Chainlink aggregator
  buyTokenPriceOracle: string;   // Chainlink aggregator
  strike: bigint;                // int256 — may be negative
  maxTimeSinceLastOracleUpdate: bigint;
}

const STOP_LOSS_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",                    type: "address" },
      { name: "buyToken",                     type: "address" },
      { name: "sellAmount",                   type: "uint256" },
      { name: "buyAmount",                    type: "uint256" },
      { name: "appData",                      type: "bytes32" },
      { name: "receiver",                     type: "address" },
      { name: "isSellOrder",                  type: "bool"    },
      { name: "isPartiallyFillable",          type: "bool"    },
      { name: "validTo",                      type: "uint32"  },
      { name: "sellTokenPriceOracle",         type: "address" },
      { name: "buyTokenPriceOracle",          type: "address" },
      { name: "strike",                       type: "int256"  },
      { name: "maxTimeSinceLastOracleUpdate", type: "uint256" },
    ],
  },
] as const;

export function decodeStopLossStaticInput(staticInput: Hex): StopLossDecodedParams {
  const [d] = decodeAbiParameters(STOP_LOSS_ABI, staticInput);
  return {
    sellToken:                    d.sellToken.toLowerCase(),
    buyToken:                     d.buyToken.toLowerCase(),
    sellAmount:                   d.sellAmount,
    buyAmount:                    d.buyAmount,
    appData:                      d.appData,
    receiver:                     d.receiver.toLowerCase(),
    isSellOrder:                  d.isSellOrder,
    isPartiallyFillable:          d.isPartiallyFillable,
    validTo:                      d.validTo,
    sellTokenPriceOracle:         d.sellTokenPriceOracle.toLowerCase(),
    buyTokenPriceOracle:          d.buyTokenPriceOracle.toLowerCase(),
    strike:                       d.strike,
    maxTimeSinceLastOracleUpdate: d.maxTimeSinceLastOracleUpdate,
  };
}
