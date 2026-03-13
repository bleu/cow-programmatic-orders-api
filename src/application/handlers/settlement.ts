import { ponder } from "ponder:registry";
import { AddressType, ownerMapping, transaction } from "ponder:schema";
import { and, eq } from "ponder";
import { AaveV3AdapterHelperAbi } from "../../../abis/AaveV3AdapterHelperAbi";
import { AAVE_V3_ADAPTER_FACTORY_ADDRESS } from "../../data";

ponder.on("GPv2Settlement:Trade", async ({ event, context }) => {
  const { owner } = event.args;
  const ownerAddress = owner.toLowerCase() as `0x${string}`;
  const chainId = context.chain.id;

  // Skip if already mapped (adapter seen in a prior trade)
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

  if (existing.length > 0) return;

  // Skip if EOA (no bytecode)
  const code = await context.client.getCode({ address: owner });
  if (!code || code === "0x") return;

  // Check for Aave adapter via FACTORY() — silently skip if call reverts
  let factoryAddress: `0x${string}`;
  try {
    factoryAddress = await context.client.readContract({
      address: owner,
      abi: AaveV3AdapterHelperAbi,
      functionName: "FACTORY",
    });
  } catch {
    // Not an Aave adapter (Safe, other ERC-1271 signer, etc.)
    return;
  }

  if (factoryAddress.toLowerCase() !== AAVE_V3_ADAPTER_FACTORY_ADDRESS) return;

  // Resolve EOA via owner()
  const eoaOwner = await context.client.readContract({
    address: owner,
    abi: AaveV3AdapterHelperAbi,
    functionName: "owner",
  });

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

  console.log(
    `[COW:SETTLEMENT:TRADE] AAVE_ADAPTER_MAPPED adapter=${ownerAddress} eoa=${eoaOwner.toLowerCase()} block=${event.block.number} chain=${chainId}`,
  );
});
