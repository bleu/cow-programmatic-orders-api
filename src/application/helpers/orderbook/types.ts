import { type discreteOrder } from "ponder:schema";
import { type OrderType } from "../../../utils/order-types";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Raw API response shape (subset of fields we use). */
export interface OrderbookOrder {
  uid: string;
  status: "open" | "fulfilled" | "expired" | "cancelled" | "presignaturePending";
  kind: "sell" | "buy";
  receiver: string | null;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  creationDate: string; // ISO 8601
  signingScheme: string;
  signature: string;
  executedSellAmount: string;
  executedBuyAmount: string;
  executedFee: string;
}

/** Processed composable order stored in cache and returned to callers.
 *  Shares field types with the discreteOrder schema for the DB-mapped fields. */
export type ComposableOrder = Pick<
  typeof discreteOrder.$inferInsert,
  "status" | "sellAmount" | "buyAmount" | "feeAmount" | "validTo" | "executedSellAmount" | "executedBuyAmount" | "executedFee"
> & {
  uid: string;
  generatorId: string;
  generatorHash: string;
  orderType: OrderType;
  creationDate: bigint;
};

/** Status + executed amounts returned by fetchOrderStatusByUids.
 *  Amounts are bigint (matching the discreteOrder columns); null when the
 *  cached entry predates the executed columns. */
export interface OrderStatusInfo {
  status: string;
  executedSellAmount: bigint | null;
  executedBuyAmount: bigint | null;
  executedFee: bigint | null;
}

/** API/cache decimal string -> bigint at the storage boundary. */
export function toBigIntOrNull(value: string | null | undefined): bigint | null {
  return value == null ? null : BigInt(value);
}

/** CoW-order fields used to enrich a flash-loan order, from the orderbook. */
export interface FlashLoanEnrichment {
  receiver: string | null;
  kind: "sell" | "buy";
  sellAmount: string;
  buyAmount: string;
  executedSellAmount: string;
  executedBuyAmount: string;
}

/** Durable-cache row shape for cow_cache.composable_order (owner passed separately). */
export interface ComposableCacheRow {
  orderUid: string;
  generatorHash: string;
  orderType: OrderType;
  status: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number | null;
  creationDate: bigint;
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
  executedFee: string | null;
}

/** Cached order data returned by getCachedUidStatuses. */
export interface CachedOrderData {
  status: string;
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
  executedFee: string | null;
}

export const TERMINAL_STATUSES = new Set(["fulfilled", "expired", "cancelled"]);
export const PAGE_LIMIT = 1000;
export const BATCH_SIZE = 50;
