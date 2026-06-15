import { ponder } from "ponder:registry";
import {
  AddressType,
  ownerMapping,
  settlementQueue,
  transaction,
} from "ponder:schema";
import { and, eq } from "ponder";
import { keccak256, toBytes } from "viem";
import { log } from "../helpers/logger";
import { AaveV3AdapterHelperAbi } from "../../../abis/AaveV3AdapterHelperAbi";
import {
  AAVE_V3_ADAPTER_FACTORY_ADDRESSES,
  GPV2_SETTLEMENT_DEPLOYMENTS,
} from "../../data";
import { BLOCK_HANDLER_RPC_TIMEOUT_MS, SETTLEMENT_INNER_RPC_TIMEOUT_MS } from "../../constants";
import { TimeoutError as _TimeoutError, withTimeout } from "../helpers/withTimeout";

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

// Max settlements resolved per SettlementResolver block tick.
const MAX_SETTLEMENTS_PER_BLOCK = 20;

// ── Event handler — enqueue only ─────────────────────────────────────────────
// All RPC work is deferred to SettlementResolver:block so errors in RPC calls
// never propagate to the event handler and crash the indexer.
ponder.on("GPv2Settlement:Settlement", async ({ event, context }) => {
  if (process.env.DISABLE_SETTLEMENT_FACTORY_CHECK === "true") return;

  await context.db
    .insert(settlementQueue)
    .values({
      txHash: event.transaction.hash,
      chainId: context.chain.id,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

// ── Block handler — drain queue and resolve adapters ─────────────────────────
ponder.on("SettlementResolver:block", async ({ event: _event, context }) => {
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

  const pending = await context.db.sql
    .select()
    .from(settlementQueue)
    .where(eq(settlementQueue.chainId, chainId))
    .limit(MAX_SETTLEMENTS_PER_BLOCK);

  if (pending.length === 0) return;

  for (const item of pending) {
    stats.total++;

    let receipt: Awaited<ReturnType<typeof context.client.getTransactionReceipt>>;
    try {
      receipt = await withTimeout(
        context.client.getTransactionReceipt({ hash: item.txHash }),
        BLOCK_HANDLER_RPC_TIMEOUT_MS,
        "settlement:getTransactionReceipt",
      );
    } catch (err) {
      log("warn", "SettlementResolver:receipt_failed", { chainId, txHash: item.txHash, err: err instanceof Error ? err.message : String(err) });
      await context.db.delete(settlementQueue, { chainId, txHash: item.txHash });
      continue;
    }

    for (const txLog of receipt.logs) {
      if (txLog.address.toLowerCase() !== settlementAddress) continue;
      if (txLog.topics[0] !== TRADE_TOPIC) continue;

      stats.tradeLogsFound++;

      const owner = `0x${txLog.topics[1]!.slice(26)}` as `0x${string}`;
      const ownerAddress = owner.toLowerCase() as `0x${string}`;

      const existing = await context.db.sql
        .select()
        .from(ownerMapping)
        .where(and(eq(ownerMapping.chainId, chainId), eq(ownerMapping.address, ownerAddress)))
        .limit(1);

      if (existing.length > 0) {
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

      let eoaOwner: `0x${string}`;
      try {
        eoaOwner = await withTimeout(
          context.client.readContract({
            address: owner,
            abi: AaveV3AdapterHelperAbi,
            functionName: "owner",
          }),
          BLOCK_HANDLER_RPC_TIMEOUT_MS,
          "settlement:readContract:owner",
        );
      } catch (err) {
        log("warn", "SettlementResolver:readOwner_failed", { chainId, owner, err: err instanceof Error ? err.message : String(err) });
        continue;
      }

      await context.db
        .insert(transaction)
        .values({
          hash: item.txHash,
          chainId,
          blockNumber: item.blockNumber,
          blockTimestamp: item.blockTimestamp,
        })
        .onConflictDoNothing();

      await context.db
        .insert(ownerMapping)
        .values({
          chainId,
          address: ownerAddress,
          owner: eoaOwner.toLowerCase() as `0x${string}`,
          addressType: AddressType.FlashLoanHelper,
          txHash: item.txHash,
          blockNumber: item.blockNumber,
          resolutionDepth: 1,
        })
        .onConflictDoNothing();

      stats.mapped++;
      logStatsIfIntervalPassed();

      log("info", "SettlementResolver:aave_adapter_mapped", { chainId, adapter: ownerAddress, eoa: eoaOwner.toLowerCase(), block: String(item.blockNumber) });
    }

    await context.db.delete(settlementQueue, { chainId, txHash: item.txHash });

    logStatsIfIntervalPassed();
  }
});
