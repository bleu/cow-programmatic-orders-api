import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem";
import { precomputeOrderUids } from "../../src/application/helpers/uidPrecompute";
import { decodeStopLossStaticInput, STOP_LOSS_ABI } from "../../src/decoders/stop-loss";

vi.mock("ponder:schema", () => ({
  candidateDiscreteOrder: {},
  conditionalOrderGenerator: {},
  discreteOrder: {},
}));

const OWNER = "0xd93adad902605beaded29a805d499250be43656c" as const;
const STOP_LOSS_PARAMS = {
  sellToken: "0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1",
  buyToken: "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0",
  sellAmount: 398653517185425n,
  buyAmount: 995638n,
  appData: "0x01a584f83b5e246a86df2983249c59bbd7a1c8e23daf139659ee21ca6e86f643",
  receiver: "0x76b0340e50bd9883d8b2ca5fd9f52439a9e7cf58",
  isSellOrder: true,
  isPartiallyFillable: false,
  validTo: 1807471125,
  sellTokenPriceOracle: "0xa767f745331d267c7751297d982b050c93985627",
  buyTokenPriceOracle: "0x26c31ac71010af62e6b486d1132e266d6298857d",
  strike: 2500000000000000000000n,
  maxTimeSinceLastOracleUpdate: 86400n,
} as const;

// Trade UID from https://gnosisscan.io/tx/0x2a692d7aeb9e8197b9db6a5c860cffb8c427c1a0ba7f7783bfb2f0ca699e890d.
const SETTLED_UID = "0x3a9bb4cd4d2362914750638f970e5297b43065813ea49718fc07b4590818b391d93adad902605beaded29a805d499250be43656c6bbbd215";

// Other flag combinations calculated independently with @cowprotocol/cow-sdk.
const FLAG_CASES = [
  { isSellOrder: true, isPartiallyFillable: false, orderUid: SETTLED_UID },
  { isSellOrder: true, isPartiallyFillable: true, orderUid: "0x01e634f83d2683974743deb001e43371807d6fff9c6bcedd81d976967c1a58b2d93adad902605beaded29a805d499250be43656c6bbbd215" },
  { isSellOrder: false, isPartiallyFillable: false, orderUid: "0xcdbd8cc556ec3e3bd7b297b5f1a760727f1ec161ae4a17dbccb9bca4091a9e97d93adad902605beaded29a805d499250be43656c6bbbd215" },
  { isSellOrder: false, isPartiallyFillable: true, orderUid: "0x3cc95c5b323c0c9882fe5609c42a77856165f81cebb91ce7efd8c4136ec3f9cbd93adad902605beaded29a805d499250be43656c6bbbd215" },
] as const;

function decodedParams(isSellOrder: boolean = true, isPartiallyFillable: boolean = false) {
  const staticInput = encodeAbiParameters(STOP_LOSS_ABI, [{
    ...STOP_LOSS_PARAMS,
    isSellOrder,
    isPartiallyFillable,
  }]);
  return JSON.parse(JSON.stringify(decodeStopLossStaticInput(staticInput), (_key, value) =>
    typeof value === "bigint" ? String(value) : value,
  )) as Record<string, string>;
}

describe("precomputeOrderUids StopLoss", () => {
  it("matches the settled Gnosis sell-order UID with decoded boolean flags", () => {
    const orders = precomputeOrderUids(100, OWNER, "StopLoss", decodedParams(), 1791919165n);

    expect(orders?.map(({ orderUid }) => orderUid)).toEqual([SETTLED_UID]);
  });

  it("includes the decoded partial-fill flag in the UID", () => {
    const orders = precomputeOrderUids(100, OWNER, "StopLoss", decodedParams(true, true), 1791919165n);

    // Independent UID vector from @cowprotocol/cow-sdk with partiallyFillable=true.
    expect(orders?.map(({ orderUid }) => orderUid)).toEqual([
      "0x01e634f83d2683974743deb001e43371807d6fff9c6bcedd81d976967c1a58b2d93adad902605beaded29a805d499250be43656c6bbbd215",
    ]);
  });

  it.each(FLAG_CASES.filter(({ isSellOrder }) => !isSellOrder))(
    "keeps decoded buy orders as buy orders (partial=$isPartiallyFillable)",
    ({ isSellOrder, isPartiallyFillable, orderUid }) => {
      const orders = precomputeOrderUids(100, OWNER, "StopLoss", decodedParams(isSellOrder, isPartiallyFillable), 1791919165n);

      expect(orders?.map(({ orderUid }) => orderUid)).toEqual([orderUid]);
    },
  );

  it.each(FLAG_CASES)(
    "supports string flags (sell=$isSellOrder, partial=$isPartiallyFillable)",
    ({ isSellOrder, isPartiallyFillable, orderUid }) => {
      const params = {
        ...decodedParams(isSellOrder, isPartiallyFillable),
        isSellOrder: String(isSellOrder),
        isPartiallyFillable: String(isPartiallyFillable),
      };
      const orders = precomputeOrderUids(100, OWNER, "StopLoss", params, 1791919165n);

      expect(orders?.map(({ orderUid }) => orderUid)).toEqual([orderUid]);
    },
  );
});
