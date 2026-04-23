import { decodeAbiParameters, type Hex } from "viem";

// Source: stakewise/v3-periphery — src/converters/SwapOrderHandler.sol
// Deployed stateless singletons:
//   Mainnet: 0xd506fe0b3ddf9e685c16e000514a835d3a511b26
//   Gnosis:  0x7a77934d32d78bfe8dc1e23415b5679960a1c610
// Non-deterministic: sellAmount = IERC20(sellToken).balanceOf(owner) at query time;
// validTo = Utils.validToBucket(validityPeriod). Only staticInput fields are decoded here.
export interface SwapOrderHandlerDecodedParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  validityPeriod: number;  // uint32 — seconds
  appData: string;         // bytes32
}

const SWAP_ORDER_HANDLER_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",      type: "address" },
      { name: "buyToken",       type: "address" },
      { name: "receiver",       type: "address" },
      { name: "validityPeriod", type: "uint32"  },
      { name: "appData",        type: "bytes32" },
    ],
  },
] as const;

export function decodeSwapOrderHandlerStaticInput(
  staticInput: Hex,
): SwapOrderHandlerDecodedParams {
  const [d] = decodeAbiParameters(SWAP_ORDER_HANDLER_ABI, staticInput);
  return {
    sellToken:      d.sellToken.toLowerCase(),
    buyToken:       d.buyToken.toLowerCase(),
    receiver:       d.receiver.toLowerCase(),
    validityPeriod: d.validityPeriod,
    appData:        d.appData,
  };
}
