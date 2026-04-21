/**
 * UID pre-computation for deterministic order types.
 *
 * Computes discrete order UIDs at creation time from staticInput params,
 * without calling getTradeableOrderWithSignature on-chain.
 *
 * Supported order types:
 *   - TWAP: all N part UIDs computable (given t0 or block.timestamp for t0=0)
 *   - StopLoss: single UID computable (order data is fully in staticInput)
 *   - CirclesBackingOrder: single UID computable (staticInput + handler immutables; receiver=owner)
 *
 * Non-deterministic types (PerpetualSwap, TradeAboveThreshold) depend on
 * on-chain state (oracle prices, balances) and cannot be pre-computed.
 *
 * Reference: composable-cow/src/types/twap/TWAP.sol, StopLoss.sol, circles-lbp/CirclesBackingOrder.sol
 */

import type { Hex } from "viem";
import { and, eq } from "ponder";
import { candidateDiscreteOrder, conditionalOrderGenerator, discreteOrder } from "ponder:schema";
import { computeOrderUid, type GPv2OrderData } from "./orderUid";
import { fetchOrderStatusByUids } from "./orderbookClient";

// GPv2Order.sol constant hashes
const KIND_SELL = "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775" as Hex;
const KIND_BUY = "0x6ed88e868af0a1983e3886d5f3e95a2fafbd6c3450bc229e27342283dc429ccc" as Hex;
const BALANCE_ERC20 = "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9" as Hex;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PrecomputedOrder {
  orderUid: string;
  validTo: number;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  possibleValidAfterTimestamp: number | null;  // TWAP: t0 + partIndex * t
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Pre-compute UIDs for a generator based on its order type and decoded params.
 *
 * Returns an array of pre-computed orders (one for StopLoss, N for TWAP).
 * Returns null if the order type is not deterministic or params are missing.
 *
 * @param chainId - chain ID
 * @param owner - order owner address
 * @param orderType - decoded order type
 * @param decodedParams - decoded staticInput params (stringified bigints)
 * @param blockTimestamp - event.block.timestamp (used as t0 when t0=0 for TWAP)
 */
export function precomputeOrderUids(
  chainId: number,
  owner: Hex,
  orderType: string,
  decodedParams: Record<string, string> | null,
  blockTimestamp: bigint,
): PrecomputedOrder[] | null {
  if (!decodedParams) return null;

  switch (orderType) {
    case "TWAP":
      return precomputeTwapUids(chainId, owner, decodedParams, blockTimestamp);
    case "StopLoss":
      return precomputeStopLossUid(chainId, owner, decodedParams);
    case "CirclesBackingOrder":
      return precomputeCirclesBackingOrderUid(chainId, owner, decodedParams);
    default:
      // PerpetualSwap, GoodAfterTime, TradeAboveThreshold — not deterministic
      return null;
  }
}

/**
 * Pre-compute UIDs, fetch their status from the API, upsert discrete orders,
 * and deactivate the generator if all orders are terminal.
 *
 * This is the full backfill flow for deterministic order types.
 * Returns true if the generator was deactivated (all orders terminal).
 * Returns false if polling is still needed or the type is non-deterministic.
 */
export async function precomputeAndDiscover(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  generatorEventId: string,
  owner: Hex,
  orderType: string,
  decodedParams: Record<string, string> | null,
  blockTimestamp: bigint,
): Promise<boolean> {
  const precomputed = precomputeOrderUids(chainId, owner, orderType, decodedParams, blockTimestamp);
  if (!precomputed || precomputed.length === 0) return false;

  const uids = precomputed.map((o) => o.orderUid);
  const statuses = await fetchOrderStatusByUids(context, chainId, uids);

  for (const order of precomputed) {
    const statusInfo = statuses.get(order.orderUid);
    const apiStatus = statusInfo?.status as
      "open" | "fulfilled" | "unfilled" | "expired" | "cancelled" | undefined;

    if (apiStatus) {
      await context.db.sql
        .insert(discreteOrder)
        .values({
          orderUid: order.orderUid,
          chainId,
          conditionalOrderGeneratorId: generatorEventId,
          status: apiStatus,
          sellAmount: order.sellAmount,
          buyAmount: order.buyAmount,
          feeAmount: order.feeAmount,
          validTo: order.validTo,
          creationDate: blockTimestamp,
          executedSellAmount: statusInfo?.executedSellAmount ?? null,
          executedBuyAmount: statusInfo?.executedBuyAmount ?? null,
        })
        .onConflictDoUpdate({
          target: [discreteOrder.chainId, discreteOrder.orderUid],
          set: { status: apiStatus, validTo: order.validTo },
        });
    } else {
      await context.db.sql
        .insert(candidateDiscreteOrder)
        .values({
          orderUid: order.orderUid,
          chainId,
          conditionalOrderGeneratorId: generatorEventId,
          possibleValidAfterTimestamp: order.possibleValidAfterTimestamp != null
            ? BigInt(order.possibleValidAfterTimestamp)
            : null,
          sellAmount: order.sellAmount,
          buyAmount: order.buyAmount,
          feeAmount: order.feeAmount,
          validTo: order.validTo,
          creationDate: blockTimestamp,
        })
        .onConflictDoNothing();
    }
  }

  const allTerminal = precomputed.every((o) => {
    const s = statuses.get(o.orderUid)?.status;
    return s === "fulfilled" || s === "expired" || s === "cancelled";
  });

  if (allTerminal) {
    await context.db.sql
      .update(conditionalOrderGenerator)
      .set({
        status: "Completed",
        allCandidatesKnown: true,
        lastPollResult: "precompute:allTerminal",
      })
      .where(
        and(
          eq(conditionalOrderGenerator.chainId, chainId),
          eq(conditionalOrderGenerator.eventId, generatorEventId),
        ),
      );
    console.log(
      `[ComposableCow] All ${precomputed.length} pre-computed orders terminal on API — generator=${generatorEventId} marked Completed`,
    );
    return true;
  }

  // UIDs are fully known even though some orders are still open —
  // C1 (Contract Poller) can skip this generator, C3 (Status Updater) tracks the open orders.
  await context.db.sql
    .update(conditionalOrderGenerator)
    .set({ allCandidatesKnown: true })
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.eventId, generatorEventId),
      ),
    );

  return false;
}

// ─── TWAP ────────────────────────────────────────────────────────────────────

/**
 * Compute all N TWAP part UIDs.
 *
 * TWAP contract logic (TWAPOrder.sol):
 *   - Each part has identical sellAmount (partSellAmount) and buyAmount (minPartLimit)
 *   - validTo = t0 + (partIndex + 1) * t - 1        (when span = 0)
 *   - validTo = t0 + partIndex * t + span - 1        (when span > 0)
 *   - feeAmount = 0, kind = SELL, partiallyFillable = false
 *   - sellTokenBalance = buyTokenBalance = ERC20
 *
 * When t0 = 0 in staticInput, the contract reads block.timestamp at creation
 * time from composableCow.cabinet(owner, ctx). We use event.block.timestamp.
 */
function precomputeTwapUids(
  chainId: number,
  owner: Hex,
  params: Record<string, string>,
  blockTimestamp: bigint,
): PrecomputedOrder[] | null {
  const sellToken = params["sellToken"] as Hex | undefined;
  const buyToken = params["buyToken"] as Hex | undefined;
  const receiver = params["receiver"] as Hex | undefined;
  const partSellAmount = params["partSellAmount"];
  const minPartLimit = params["minPartLimit"];
  const t0Raw = params["t0"];
  const n = params["n"];
  const t = params["t"];
  const span = params["span"];
  const appData = params["appData"] as Hex | undefined;

  if (!sellToken || !buyToken || !partSellAmount || !minPartLimit || !n || !t || !appData) {
    return null;
  }

  const nParts = Number(BigInt(n));
  const tSeconds = BigInt(t);
  const spanSeconds = BigInt(span ?? "0");
  // When t0 = 0, the contract uses block.timestamp at creation
  const t0 = BigInt(t0Raw ?? "0") === 0n ? blockTimestamp : BigInt(t0Raw!);

  if (nParts <= 0 || nParts > 10000 || tSeconds <= 0n) return null;

  const orders: PrecomputedOrder[] = [];

  for (let i = 0; i < nParts; i++) {
    const partIndex = BigInt(i);
    let validTo: number;

    if (spanSeconds === 0n) {
      // validTo = t0 + (partIndex + 1) * t - 1
      validTo = Number(t0 + (partIndex + 1n) * tSeconds - 1n);
    } else {
      // validTo = t0 + partIndex * t + span - 1
      validTo = Number(t0 + partIndex * tSeconds + spanSeconds - 1n);
    }

    // Receiver: address(0) in the struct means "send to owner"
    const resolvedReceiver =
      receiver === "0x0000000000000000000000000000000000000000"
        ? owner
        : (receiver ?? owner);

    const orderData: GPv2OrderData = {
      sellToken,
      buyToken,
      receiver: resolvedReceiver as Hex,
      sellAmount: BigInt(partSellAmount),
      buyAmount: BigInt(minPartLimit),
      validTo,
      appData,
      feeAmount: 0n,
      kind: KIND_SELL,
      partiallyFillable: false,
      sellTokenBalance: BALANCE_ERC20,
      buyTokenBalance: BALANCE_ERC20,
    };

    const uid = computeOrderUid(chainId, orderData, owner);

    orders.push({
      orderUid: uid.toLowerCase(),
      validTo,
      sellAmount: partSellAmount,
      buyAmount: minPartLimit,
      feeAmount: "0",
      possibleValidAfterTimestamp: Number(t0 + partIndex * tSeconds),
    });
  }

  return orders;
}

// ─── StopLoss ────────────────────────────────────────────────────────────────

/**
 * Compute the single StopLoss UID.
 *
 * StopLoss contract logic (StopLoss.sol):
 *   - All order fields come directly from staticInput
 *   - Oracle calls only gate execution (don't affect order data)
 *   - feeAmount = 0
 *   - kind = KIND_SELL if isSellOrder, else KIND_BUY
 *   - sellTokenBalance = buyTokenBalance = ERC20
 */
function precomputeStopLossUid(
  chainId: number,
  owner: Hex,
  params: Record<string, string>,
): PrecomputedOrder[] | null {
  const sellToken = params["sellToken"] as Hex | undefined;
  const buyToken = params["buyToken"] as Hex | undefined;
  const receiver = params["receiver"] as Hex | undefined;
  const sellAmount = params["sellAmount"];
  const buyAmount = params["buyAmount"];
  const appData = params["appData"] as Hex | undefined;
  const isSellOrder = params["isSellOrder"];
  const isPartiallyFillable = params["isPartiallyFillable"];
  const validTo = params["validTo"];

  if (!sellToken || !buyToken || !sellAmount || !buyAmount || !appData || !validTo) {
    return null;
  }

  const resolvedReceiver =
    receiver === "0x0000000000000000000000000000000000000000"
      ? owner
      : (receiver ?? owner);

  const orderData: GPv2OrderData = {
    sellToken,
    buyToken,
    receiver: resolvedReceiver as Hex,
    sellAmount: BigInt(sellAmount),
    buyAmount: BigInt(buyAmount),
    validTo: Number(validTo),
    appData,
    feeAmount: 0n,
    kind: isSellOrder === "true" ? KIND_SELL : KIND_BUY,
    partiallyFillable: isPartiallyFillable === "true",
    sellTokenBalance: BALANCE_ERC20,
    buyTokenBalance: BALANCE_ERC20,
  };

  const uid = computeOrderUid(chainId, orderData, owner);

  return [{
    orderUid: uid.toLowerCase(),
    validTo: Number(validTo),
    sellAmount,
    buyAmount,
    feeAmount: "0",
    possibleValidAfterTimestamp: null,
  }];
}

// ─── CirclesBackingOrder ────────────────────────────────────────────────────

/**
 * Compute the single CirclesBackingOrder UID.
 *
 * Source: aboutcircles/circles-lbp/src/CirclesBackingOrder.sol (verified on Gnosis).
 *   - sellToken, sellAmount come from handler constructor immutables (merged into
 *     decodedParams by the event handler before calling here).
 *   - buyToken, buyAmount, validTo, appData come from staticInput.
 *   - receiver = owner (hardcoded in getOrder).
 *   - kind = KIND_SELL, partiallyFillable = false, feeAmount = 0,
 *     sellTokenBalance = buyTokenBalance = BALANCE_ERC20 (all contract constants).
 *   - On-chain reads in getTradeableOrder are revert guards only — they do not
 *     affect the returned order, so the UID is fully deterministic at creation.
 */
function precomputeCirclesBackingOrderUid(
  chainId: number,
  owner: Hex,
  params: Record<string, string>,
): PrecomputedOrder[] | null {
  const sellToken = params["sellToken"] as Hex | undefined;
  const buyToken = params["buyToken"] as Hex | undefined;
  const sellAmount = params["sellAmount"];
  const buyAmount = params["buyAmount"];
  const validTo = params["validTo"];
  const appData = params["appData"] as Hex | undefined;

  if (!sellToken || !buyToken || !sellAmount || !buyAmount || !validTo || !appData) {
    return null;
  }

  const orderData: GPv2OrderData = {
    sellToken,
    buyToken,
    receiver: owner,
    sellAmount: BigInt(sellAmount),
    buyAmount: BigInt(buyAmount),
    validTo: Number(validTo),
    appData,
    feeAmount: 0n,
    kind: KIND_SELL,
    partiallyFillable: false,
    sellTokenBalance: BALANCE_ERC20,
    buyTokenBalance: BALANCE_ERC20,
  };

  const uid = computeOrderUid(chainId, orderData, owner);

  return [{
    orderUid: uid.toLowerCase(),
    validTo: Number(validTo),
    sellAmount,
    buyAmount,
    feeAmount: "0",
    possibleValidAfterTimestamp: null,
  }];
}
