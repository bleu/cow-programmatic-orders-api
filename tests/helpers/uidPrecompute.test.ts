import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, zeroAddress } from "viem";
import { MAX_TWAP_PRECOMPUTE_PARTS } from "../../src/constants";
import { TWAP_ABI } from "../../src/decoders/twap";
import { CIRCLES_BACKING_ORDER_ABI } from "../../src/decoders/circles-backing-order";
import { precomputeOrderUids } from "../../src/application/helpers/uidPrecompute";
import { decodeStaticInput } from "../../src/decoders";
import { STOP_LOSS_ABI } from "../../src/decoders/stop-loss";

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

function decodedOrder(isSellOrder: boolean = true, isPartiallyFillable: boolean = false) {
  const staticInput = encodeAbiParameters(STOP_LOSS_ABI, [{
    ...STOP_LOSS_PARAMS,
    isSellOrder,
    isPartiallyFillable,
  }]);
  const order = decodeStaticInput("StopLoss", staticInput);
  if (order?.orderType !== "StopLoss") throw new Error("Expected a decoded StopLoss order");
  return order;
}

function decodedTwap(t0: bigint = 1791919165n, span: bigint = 0n) {
  const staticInput = encodeAbiParameters(TWAP_ABI, [{
    sellToken: STOP_LOSS_PARAMS.sellToken,
    buyToken: STOP_LOSS_PARAMS.buyToken,
    receiver: STOP_LOSS_PARAMS.receiver,
    partSellAmount: STOP_LOSS_PARAMS.sellAmount,
    minPartLimit: STOP_LOSS_PARAMS.buyAmount,
    t0,
    n: 2n,
    t: 3600n,
    span,
    appData: STOP_LOSS_PARAMS.appData,
  }]);
  const order = decodeStaticInput("TWAP", staticInput);
  if (order?.orderType !== "TWAP") throw new Error("Expected a decoded TWAP order");
  return order;
}

describe("precomputeOrderUids StopLoss", () => {
  it("matches the settled Gnosis UID with native decoded parameters", () => {
    const orders = precomputeOrderUids(100, OWNER, decodedOrder(), 1791919165n);

    expect(orders?.map(({ orderUid }) => orderUid)).toEqual([SETTLED_UID]);
  });

  it.each(FLAG_CASES.filter(({ orderUid }) => orderUid !== SETTLED_UID))(
    "hashes native flags (sell=$isSellOrder, partial=$isPartiallyFillable)",
    ({ isSellOrder, isPartiallyFillable, orderUid }) => {
      const orders = precomputeOrderUids(100, OWNER, decodedOrder(isSellOrder, isPartiallyFillable), 1791919165n);

      expect(orders?.map(({ orderUid }) => orderUid)).toEqual([orderUid]);
    },
  );
});

describe("precomputeOrderUids TWAP", () => {
  it.each([1791919165n, 0n])("matches the SDK part UIDs with t0=%s", (t0) => {
    const orders = precomputeOrderUids(100, OWNER, decodedTwap(t0), 1791919165n);

    expect(orders).toEqual([
      {
        orderUid: "0x617626d506623014d270ac73569bd719e39def0cd16db1423f53149c5695194ed93adad902605beaded29a805d499250be43656c6ace924c",
        validTo: 1791922764,
        sellAmount: "398653517185425",
        buyAmount: "995638",
        feeAmount: "0",
        possibleValidAfterTimestamp: 1791919165,
      },
      {
        orderUid: "0x2a9eda4e6c03b522c7ea9163c5e5ea4e8f4429b745bfe6a15efba7badf842d25d93adad902605beaded29a805d499250be43656c6acea05c",
        validTo: 1791926364,
        sellAmount: "398653517185425",
        buyAmount: "995638",
        feeAmount: "0",
        possibleValidAfterTimestamp: 1791922765,
      },
    ]);
  });

  it("uses span for each part's expiry", () => {
    const orders = precomputeOrderUids(100, OWNER, decodedTwap(1791919165n, 1800n), 1791919165n);

    expect(orders?.map(({ orderUid, validTo }) => ({ orderUid, validTo }))).toEqual([
      {
        orderUid: "0x21f0f7d31f874eb084b0f9b3bba19080322a0f240f73be20572c3f231cc7ea24d93adad902605beaded29a805d499250be43656c6ace8b44",
        validTo: 1791920964,
      },
      {
        orderUid: "0xb4bd83cfe9231868cb6d6230827fa7a80524a25aad26c94f5beb6b40e1cc4cecd93adad902605beaded29a805d499250be43656c6ace9954",
        validTo: 1791924564,
      },
    ]);
  });

  it("sends TWAP proceeds to the owner when receiver is zero", () => {
    const order = decodedTwap();
    order.decodedParams.receiver = zeroAddress;
    const orders = precomputeOrderUids(100, OWNER, order, 1791919165n);

    expect(orders?.map(({ orderUid }) => orderUid)).toEqual([
      "0x832bae10ba024e36cecb2daf040ca30e1cbf57a4e18af54a021d7256bb3e635ed93adad902605beaded29a805d499250be43656c6ace924c",
      "0xddc5190ae8ae8cc07e7947abc39d08faf26316b01d3d5376730854a5b350016fd93adad902605beaded29a805d499250be43656c6acea05c",
    ]);
  });
});

describe("precomputeOrderUids CirclesBackingOrder", () => {
  it("matches the SDK UID with native handler immutables", () => {
    const staticInput = encodeAbiParameters(CIRCLES_BACKING_ORDER_ABI, [{
      buyToken: STOP_LOSS_PARAMS.buyToken,
      buyAmount: STOP_LOSS_PARAMS.buyAmount,
      validTo: STOP_LOSS_PARAMS.validTo,
      appData: STOP_LOSS_PARAMS.appData,
    }]);
    const order = decodeStaticInput("CirclesBackingOrder", staticInput);
    if (order?.orderType !== "CirclesBackingOrder") throw new Error("Expected a decoded CirclesBackingOrder");
    const enrichedOrder = {
      orderType: order.orderType,
      decodedParams: {
        ...order.decodedParams,
        sellToken: STOP_LOSS_PARAMS.sellToken,
        sellAmount: STOP_LOSS_PARAMS.sellAmount,
      },
    };
    const orders = precomputeOrderUids(100, OWNER, enrichedOrder, 1791919165n);

    expect(orders).toEqual([{
      orderUid: "0x576d82dc5c10c01045f3994d725a6cb2804ab9d6dfc592431ea145dc1d75da1bd93adad902605beaded29a805d499250be43656c6bbbd215",
      validTo: 1807471125,
      sellAmount: "398653517185425",
      buyAmount: "995638",
      feeAmount: "0",
      possibleValidAfterTimestamp: null,
    }]);
  });
});

describe("precomputeOrderUids skip cases", () => {
  it.each([
    { n: 0n, t: 3600n },
    { n: 2n, t: 0n },
    { n: BigInt(MAX_TWAP_PRECOMPUTE_PARTS) + 1n, t: 3600n },
  ])("skips unsupported TWAP parts (n=$n, t=$t)", ({ n, t }) => {
    const order = decodedTwap();
    order.decodedParams.n = n;
    order.decodedParams.t = t;

    expect(precomputeOrderUids(100, OWNER, order, 1791919165n)).toBeNull();
  });

  it.each(["TWAP", "StopLoss", "CirclesBackingOrder", "Unknown"] as const)(
    "skips %s when decoded parameters are null",
    (orderType) => {
      expect(precomputeOrderUids(100, OWNER, { orderType, decodedParams: null }, 1791919165n)).toBeNull();
    },
  );

  it("skips non-deterministic orders with native decoded parameters", () => {
    const order = {
      orderType: "PerpetualSwap",
      decodedParams: {
        tokenA: STOP_LOSS_PARAMS.sellToken,
        tokenB: STOP_LOSS_PARAMS.buyToken,
        validityBucketSeconds: 900,
        halfSpreadBps: 5n,
        appData: STOP_LOSS_PARAMS.appData,
      },
    } as const;

    expect(precomputeOrderUids(100, OWNER, order, 1791919165n)).toBeNull();
  });
});
