import { ponder } from "ponder:registry";
import { AddressType, conditionalOrderGenerator, ownerMapping, transaction } from "ponder:schema";
import { and, eq } from "ponder";
import { keccak256, toBytes } from "viem";
import { cowLog } from "../helpers/cowLogger";
import { AaveV3AdapterHelperAbi } from "../../../abis/AaveV3AdapterHelperAbi";
import {
  AAVE_V3_ADAPTER_FACTORY_ADDRESSES,
  GPV2_SETTLEMENT_DEPLOYMENTS,
} from "../../data";
import { BLOCK_HANDLER_RPC_TIMEOUT_MS } from "../../constants";
import { TimeoutError, withTimeout } from "../helpers/withTimeout";

// Trade(address,address,address,uint256,uint256,uint256,bytes) — topic0 hash
const TRADE_TOPIC = keccak256(
  toBytes("Trade(address,address,address,uint256,uint256,uint256,bytes)"),
);

// ── Stats / timing ────────────────────────────────────────────────────────────
// Logged every LOG_INTERVAL_MS to measure per-step cost without flooding logs.
const stats = {
  total: 0, // Settlement events processed
  tradeLogsFound: 0, // Trade logs found in receipts
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
  cowLog("info", "settlement:stats", {
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

ponder.on("GPv2Settlement:Settlement", async ({ event, context }) => {
  // Kill switch: set DISABLE_SETTLEMENT_FACTORY_CHECK=true to skip all RPC
  // calls in this handler. Use to benchmark base throughput vs. factory cost.
  if (process.env.DISABLE_SETTLEMENT_FACTORY_CHECK === "true") return;

  const chainId = context.chain.id;
  const chainName = context.chain.name;

  // Resolve chain-specific addresses — skip safely if chain is not configured
  const settlementDeployment =
    GPV2_SETTLEMENT_DEPLOYMENTS[
      chainName as keyof typeof GPV2_SETTLEMENT_DEPLOYMENTS
    ];
  if (!settlementDeployment) return;
  const settlementAddress = settlementDeployment.address.toLowerCase();

  const adapterFactoryAddress =
    AAVE_V3_ADAPTER_FACTORY_ADDRESSES[
      chainName as keyof typeof AAVE_V3_ADAPTER_FACTORY_ADDRESSES
    ]?.toLowerCase();
  if (!adapterFactoryAddress) return;

  stats.total++;

  // Fetch the full receipt to access all logs in the transaction.
  // FlashLoanRouter settlements only, but 27k+ adapters were resolved in practice —
  // the RPC call is meaningful and must be timeout-guarded.
  let receipt: Awaited<ReturnType<typeof context.client.getTransactionReceipt>>;
  try {
    receipt = await withTimeout(
      context.client.getTransactionReceipt({ hash: event.transaction.hash }),
      BLOCK_HANDLER_RPC_TIMEOUT_MS,
      "settlement:getTransactionReceipt",
    );
  } catch (err) {
    if (err instanceof TimeoutError) return;
    throw err;
  }

  for (const log of receipt.logs) {
    // Only Trade logs emitted by GPv2Settlement in this same transaction
    if (log.address.toLowerCase() !== settlementAddress) continue;
    if (log.topics[0] !== TRADE_TOPIC) continue;

    stats.tradeLogsFound++;

    // Decode owner from topics[1] — ABI-encoded 32-byte padded address
    const owner = `0x${log.topics[1]!.slice(26)}` as `0x${string}`;
    const ownerAddress = owner.toLowerCase() as `0x${string}`;

    // Skip if already mapped (adapter seen in a prior settlement)
    const existing = await context.db.sql
      .select()
      .from(ownerMapping)
      .where(
        and(
          eq(ownerMapping.chainId, chainId),
          eq(ownerMapping.address, ownerAddress),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      stats.skippedAlreadyMapped++;
      logStatsIfIntervalPassed();
      continue;
    }

    // Skip if EOA (no bytecode)
    let code: `0x${string}` | undefined;
    try {
      code = await withTimeout(
        context.client.getCode({ address: owner }),
        BLOCK_HANDLER_RPC_TIMEOUT_MS,
        "settlement:getCode",
      );
    } catch (err) {
      if (err instanceof TimeoutError) continue;
      throw err;
    }
    if (!code || code === "0x") {
      stats.skippedEOA++;
      logStatsIfIntervalPassed();
      continue;
    }

    // Check for Aave adapter via raw eth_call.
    // readContract() is intentionally avoided here: Ponder logs a WARN for every
    // revert, and FACTORY() reverts on any non-adapter contract.
    const t1 = Date.now();
    let factoryData: `0x${string}` | undefined;
    try {
      const result = await withTimeout(
        context.client.call({ to: owner, data: FACTORY_SELECTOR }),
        BLOCK_HANDLER_RPC_TIMEOUT_MS,
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

    // ABI-encoded address = 32 bytes = 66 hex chars (including 0x prefix)
    if (!factoryData || factoryData.length < 66) {
      stats.skippedNotAdapter++;
      logStatsIfIntervalPassed();
      continue;
    }

    // Decode padded address: 0x + 24 zero-padding hex chars + 40 address hex chars
    const factoryAddress = `0x${factoryData.slice(26)}` as `0x${string}`;

    if (factoryAddress.toLowerCase() !== adapterFactoryAddress) {
      stats.skippedNotAdapter++;
      logStatsIfIntervalPassed();
      continue;
    }

    // Resolve EOA via owner() — this call should always succeed at this point
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
      if (err instanceof TimeoutError) continue;
      throw err;
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

    await context.db
      .insert(ownerMapping)
      .values({
        chainId,
        address: ownerAddress,
        owner: eoaOwner.toLowerCase() as `0x${string}`,
        addressType: AddressType.FlashLoanHelper,
        txHash: event.transaction.hash,
        blockNumber: event.block.number,
        resolutionDepth: 1,
      })
      .onConflictDoNothing();

    await context.db.sql
      .update(conditionalOrderGenerator)
      .set({ ownerAddressType: AddressType.FlashLoanHelper })
      .where(
        and(
          eq(conditionalOrderGenerator.chainId, chainId),
          eq(conditionalOrderGenerator.owner, ownerAddress),
        ),
      );

    stats.mapped++;
    logStatsIfIntervalPassed();

    cowLog("info", "settlement:aave_adapter_mapped", {
      block: String(event.block.number),
      chainId,
      adapter: ownerAddress,
      eoa: eoaOwner.toLowerCase(),
    });
  }

  logStatsIfIntervalPassed();
});
