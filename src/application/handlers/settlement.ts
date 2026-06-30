import { ponder } from "ponder:registry";
import {
  AddressType,
  flashLoanOrder,
  ownerMapping,
  transaction,
} from "ponder:schema";
import { keccak256, toBytes } from "viem";
import { log } from "../helpers/logger";
import { AaveV3AdapterHelperAbi } from "../../../abis/AaveV3AdapterHelperAbi";
import {
  AAVE_V3_ADAPTER_FACTORY_ADDRESSES,
  GPV2_SETTLEMENT_DEPLOYMENTS,
} from "../../data";
import { BLOCK_HANDLER_RPC_TIMEOUT_MS, SETTLEMENT_INNER_RPC_TIMEOUT_MS } from "../../constants";
import { withTimeout } from "../helpers/withTimeout";
import {
  decodeTradeData,
  decodeValidToFromOrderUid,
  detectFlashLoanOrderType,
  normalizeHookData,
  type HookEnrichment,
  type HookOrderData,
} from "../../decoders/flash-loan-order";

// Trade(address,address,address,uint256,uint256,uint256,bytes) — topic0 hash
const TRADE_TOPIC = keccak256(
  toBytes("Trade(address,address,address,uint256,uint256,uint256,bytes)"),
);

// ── Stats / timing ────────────────────────────────────────────────────────────
const stats = {
  total: 0,
  tradeLogsFound: 0,
  skippedAlreadyMapped: 0,
  skippedEOA: 0,
  skippedNotAdapter: 0,
  mapped: 0,
  msFactory: 0,
};
let statsLastLogAt = Date.now();
const LOG_INTERVAL_MS = 30_000;

function logStatsIfIntervalPassed() {
  if (Date.now() - statsLastLogAt < LOG_INTERVAL_MS) return;
  const contractAddresses =
    stats.tradeLogsFound - stats.skippedAlreadyMapped - stats.skippedEOA;
  log("info", "settlement:stats", {
    settlements: stats.total,
    tradeLogs: stats.tradeLogsFound,
    alreadyMapped: stats.skippedAlreadyMapped,
    eoa: stats.skippedEOA,
    notAdapter: stats.skippedNotAdapter,
    mapped: stats.mapped,
    avgFactoryMs: contractAddresses > 0 ? Number((stats.msFactory / contractAddresses).toFixed(1)) : 0,
  });
  statsLastLogAt = Date.now();
}

// FACTORY() selector — keccak256("FACTORY()")[0:4], confirmed from RPC logs.
// Using raw eth_call instead of readContract to avoid Ponder's WARN on revert,
// which floods the log since non-adapter contracts do not implement FACTORY().
const FACTORY_SELECTOR = "0x2dd31000" as const;

// ── Event handler — inline Aave adapter discovery ────────────────────────────
// RPC work runs directly in the event handler with try/catch on every call so
// a failed fetch skips the settlement without crashing the indexer.
// Previously deferred to a SettlementResolver:block queue; the queue caused
// 30k+ context.db.sql calls per realtime block, widening the multichain qb race.
ponder.on("GPv2Settlement:Settlement", async ({ event, context }) => {
  if (process.env.DISABLE_SETTLEMENT_FACTORY_CHECK === "true") return;

  const chainId = context.chain.id;
  const chainName = context.chain.name;

  const settlementDeployment =
    GPV2_SETTLEMENT_DEPLOYMENTS[chainName as keyof typeof GPV2_SETTLEMENT_DEPLOYMENTS];
  if (!settlementDeployment) return;
  const settlementAddress = settlementDeployment.address.toLowerCase();

  const adapterFactoryAddress =
    AAVE_V3_ADAPTER_FACTORY_ADDRESSES[
      chainName as keyof typeof AAVE_V3_ADAPTER_FACTORY_ADDRESSES
    ]?.toLowerCase();
  if (!adapterFactoryAddress) return;

  stats.total++;

  let receipt: Awaited<ReturnType<typeof context.client.getTransactionReceipt>>;
  try {
    receipt = await withTimeout(
      context.client.getTransactionReceipt({ hash: event.transaction.hash }),
      BLOCK_HANDLER_RPC_TIMEOUT_MS,
      "settlement:getTransactionReceipt",
    );
  } catch (err) {
    log("warn", "SettlementResolver:receipt_failed", { chainId, txHash: event.transaction.hash, err: err instanceof Error ? err.message : String(err) });
    return;
  }

  for (const txLog of receipt.logs) {
    if (txLog.address.toLowerCase() !== settlementAddress) continue;
    if (txLog.topics[0] !== TRADE_TOPIC) continue;

    stats.tradeLogsFound++;

    const owner = `0x${txLog.topics[1]!.slice(26)}` as `0x${string}`;
    const ownerAddress = owner.toLowerCase() as `0x${string}`;

    const existingMapping = await context.db.find(ownerMapping, { chainId, address: ownerAddress });
    if (existingMapping) {
      stats.skippedAlreadyMapped++;
      logStatsIfIntervalPassed();
      continue;
    }

    let code: `0x${string}` | undefined;
    try {
      code = await withTimeout(
        context.client.getCode({ address: owner }),
        SETTLEMENT_INNER_RPC_TIMEOUT_MS,
        "settlement:getCode",
      );
    } catch (err) {
      log("warn", "SettlementResolver:getCode_failed", { chainId, owner, err: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!code || code === "0x") {
      stats.skippedEOA++;
      logStatsIfIntervalPassed();
      continue;
    }

    const t1 = Date.now();
    let factoryData: `0x${string}` | undefined;
    try {
      const result = await withTimeout(
        context.client.call({ to: owner, data: FACTORY_SELECTOR }),
        SETTLEMENT_INNER_RPC_TIMEOUT_MS,
        "settlement:call:FACTORY",
      );
      factoryData = result.data;
    } catch {
      stats.msFactory += Date.now() - t1;
      stats.skippedNotAdapter++;
      logStatsIfIntervalPassed();
      continue;
    }
    stats.msFactory += Date.now() - t1;

    if (!factoryData || factoryData.length < 66) {
      stats.skippedNotAdapter++;
      logStatsIfIntervalPassed();
      continue;
    }

    const factoryAddress = `0x${factoryData.slice(26)}` as `0x${string}`;
    if (factoryAddress.toLowerCase() !== adapterFactoryAddress) {
      stats.skippedNotAdapter++;
      logStatsIfIntervalPassed();
      continue;
    }

    // Confirmed Aave adapter. This is also where the order itself is recorded:
    // adapter <-> order is 1:1 (fresh CREATE2 deployment per order), so the
    // "already-mapped → skip" path above can never drop an order.

    // Decode the Trade log data the topic-only read above discarded.
    let trade;
    try {
      trade = decodeTradeData(txLog.data);
    } catch (err) {
      log("warn", "SettlementResolver:decodeTrade_failed", { chainId, owner, err: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const validTo = decodeValidToFromOrderUid(trade.orderUid);
    // EIP-1167 implementation → adapter type, from the getCode result above (no extra RPC).
    const flashLoanType = detectFlashLoanOrderType(code);

    // Graceful degradation: getHookData() first — one RPC yields the resolved
    // owner (for the mapping) and the order enrichment fields. On failure, fall
    // back to owner() for the mapping; the order is still written with the
    // getHookData-sourced fields null. owner-mapping reliability must not regress.
    let eoaOwner: `0x${string}` | undefined;
    let hook: HookEnrichment | null = null;
    try {
      const hookData = await withTimeout(
        context.client.readContract({
          address: owner,
          abi: AaveV3AdapterHelperAbi,
          functionName: "getHookData",
        }),
        SETTLEMENT_INNER_RPC_TIMEOUT_MS,
        "settlement:readContract:getHookData",
      );
      hook = normalizeHookData(hookData as HookOrderData);
      eoaOwner = hook.owner;
    } catch {
      try {
        const resolved = await withTimeout(
          context.client.readContract({
            address: owner,
            abi: AaveV3AdapterHelperAbi,
            functionName: "owner",
          }),
          BLOCK_HANDLER_RPC_TIMEOUT_MS,
          "settlement:readContract:owner",
        );
        eoaOwner = resolved.toLowerCase() as `0x${string}`;
      } catch (err) {
        log("warn", "SettlementResolver:readOwner_failed", { chainId, owner, err: err instanceof Error ? err.message : String(err) });
      }
    }

    await context.db
      .insert(transaction)
      .values({
        hash: event.transaction.hash,
        chainId,
        blockNumber: event.block.number,
        blockTimestamp: event.block.timestamp,
      })
      .onConflictDoNothing();

    // The order row is always created (idempotent for re-org replay).
    await context.db
      .insert(flashLoanOrder)
      .values({
        orderUid: trade.orderUid,
        chainId,
        adapter: ownerAddress,
        sellToken: trade.sellToken,
        buyToken: trade.buyToken,
        executedSellAmount: trade.sellAmount.toString(),
        executedBuyAmount: trade.buyAmount.toString(),
        feeAmount: trade.feeAmount.toString(),
        txHash: event.transaction.hash,
        blockNumber: event.block.number,
        blockTimestamp: event.block.timestamp,
        validTo,
        owner: hook?.owner ?? null,
        receiver: hook?.receiver ?? null,
        kind: hook?.kind ?? null,
        sellAmountIntended: hook?.sellAmountIntended ?? null,
        buyAmountIntended: hook?.buyAmountIntended ?? null,
        flashLoanAmount: hook?.flashLoanAmount ?? null,
        flashLoanFeeAmount: hook?.flashLoanFeeAmount ?? null,
        source: "aave",
        type: flashLoanType,
      })
      .onConflictDoNothing();

    // The mapping is written whenever the EOA resolved (happy path or fallback).
    if (eoaOwner) {
      await context.db
        .insert(ownerMapping)
        .values({
          chainId,
          address: ownerAddress,
          owner: eoaOwner,
          addressType: AddressType.FlashLoanHelper,
          txHash: event.transaction.hash,
          blockNumber: event.block.number,
          resolutionDepth: 1,
        })
        .onConflictDoNothing();

      stats.mapped++;
    }
    logStatsIfIntervalPassed();

    log("info", "SettlementResolver:aave_adapter_mapped", { chainId, adapter: ownerAddress, eoa: eoaOwner ?? null, orderUid: trade.orderUid, type: flashLoanType, hookData: hook !== null, block: String(event.block.number) });
  }

  logStatsIfIntervalPassed();
});
