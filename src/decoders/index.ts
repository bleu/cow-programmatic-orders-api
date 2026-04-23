import type { Hex } from "viem";
import type { OrderType } from "../utils/order-types";
import { decodeTwapStaticInput } from "./twap";
import { decodeStopLossStaticInput } from "./stop-loss";
import { decodePerpetualSwapStaticInput } from "./perpetual-swap";
import { decodeGoodAfterTimeStaticInput } from "./good-after-time";
import { decodeTradeAboveThresholdStaticInput } from "./trade-above-threshold";
import { decodeCirclesBackingOrderStaticInput } from "./circles-backing-order";
import { decodeSwapOrderHandlerStaticInput } from "./swap-order-handler";
import { decodeErc4626CowSwapFeeBurnerStaticInput } from "./erc4626-cow-swap-fee-burner";

export {
  decodeTwapStaticInput,
  decodeStopLossStaticInput,
  decodePerpetualSwapStaticInput,
  decodeGoodAfterTimeStaticInput,
  decodeTradeAboveThresholdStaticInput,
  decodeCirclesBackingOrderStaticInput,
  decodeSwapOrderHandlerStaticInput,
  decodeErc4626CowSwapFeeBurnerStaticInput,
};

export function decodeStaticInput(orderType: OrderType, staticInput: Hex): unknown {
  switch (orderType) {
    case "TWAP":                    return decodeTwapStaticInput(staticInput);
    case "StopLoss":                return decodeStopLossStaticInput(staticInput);
    case "PerpetualSwap":           return decodePerpetualSwapStaticInput(staticInput);
    case "GoodAfterTime":           return decodeGoodAfterTimeStaticInput(staticInput);
    case "TradeAboveThreshold":     return decodeTradeAboveThresholdStaticInput(staticInput);
    case "CirclesBackingOrder":     return decodeCirclesBackingOrderStaticInput(staticInput);
    case "SwapOrderHandler":        return decodeSwapOrderHandlerStaticInput(staticInput);
    case "ERC4626CowSwapFeeBurner": return decodeErc4626CowSwapFeeBurnerStaticInput(staticInput);
    case "Unknown":                 return null;
  }
}
