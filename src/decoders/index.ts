import type { Hex } from "viem";
import type { OrderType } from "../utils/order-types";
import { decodeTwapStaticInput } from "./twap";
import { decodeStopLossStaticInput } from "./stop-loss";
import { decodePerpetualSwapStaticInput } from "./perpetual-swap";
import { decodeGoodAfterTimeStaticInput } from "./good-after-time";
import { decodeTradeAboveThresholdStaticInput } from "./trade-above-threshold";

export {
  decodeTwapStaticInput,
  decodeStopLossStaticInput,
  decodePerpetualSwapStaticInput,
  decodeGoodAfterTimeStaticInput,
  decodeTradeAboveThresholdStaticInput,
};

export function decodeStaticInput(orderType: OrderType, staticInput: Hex): unknown {
  switch (orderType) {
    case "TWAP":                return decodeTwapStaticInput(staticInput);
    case "StopLoss":            return decodeStopLossStaticInput(staticInput);
    case "PerpetualSwap":       return decodePerpetualSwapStaticInput(staticInput);
    case "GoodAfterTime":       return decodeGoodAfterTimeStaticInput(staticInput);
    case "TradeAboveThreshold": return decodeTradeAboveThresholdStaticInput(staticInput);
  }
}
