# Programmatic Orders API - Project References

Important repositories, links, and resources for the CoW Protocol Programmatic Orders API project.

---

## Our Repositories

- **PoC - Signature Decoder**: https://github.com/bleu/cow-programmatic-orders-indexer - Proof of concept that indexes ComposableCoW events and decodes EIP-1271 signatures to match orders. Built with Ponder.
- **Old Composable CoW API**: https://github.com/bleu/composable-cow-api - Previous API for tracking stop-loss orders, forked from milkman-api. Used for the Stop Loss Safe App. May serve as reference but likely outdated.

---

## CoW Protocol Repositories

- **Composable CoW**: https://github.com/cowprotocol/composable-cow - Main composable conditional orders contracts (TWAP, Stop Loss, etc.)
- **ERC1271Forwarder**: https://github.com/cowprotocol/composable-cow/blob/main/src/ERC1271Forwarder.sol#L30 - Key contract for signature decoding
- **Watch Tower**: https://github.com/cowprotocol/watch-tower - Indexes composable cow on-chain events and posts discrete orders when conditions are met
- **cow-sdk composable**: https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/orderTypes/Twap.ts - SDK for composable order types, includes PollResultErrors for watchtower-style logic
- **cow-sdk types**: https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/types.ts#L183 - Type definitions including PollResultErrors
- **CoWShed PR (ComposableCoW for EOAs)**: https://github.com/cowdao-grants/cow-shed/pull/53 - PR adding CoWShedForComposableCow support

---

## Documentation & Forum

- **Grant Application (Forum)**: https://forum.cow.fi/t/grant-application-programmatic-orders-api/3346
- **CoW Protocol Programmatic Orders Docs**: https://docs.cow.fi/cow-protocol/concepts/order-types/programmatic-orders
- **Ponder Framework**: https://ponder.sh/

---

## Example Orders (for testing/reference)

- **AAVE Flash Loan order (Polygon)**: https://explorer.cow.fi/pol/orders/0x77726d17b9c6834fd79ff1ef65c743bf976cc63fbf51d4ac059b3700a00b631269f36c745e525a75332d00edb1a79edb084f18d26931b166

---

## Contract Addresses (from PoC)

- **ComposableCoW (Ethereum Mainnet)**: `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74`
- **Perpetual Swap Handler (Ethereum Mainnet)**: `0x519ba24e959e33b3b6220ca98bd353d8c2d89920`

---

## TODO - Addresses to Research

- ComposableCoW addresses for all supported chains (Gnosis Chain, Arbitrum, etc.)
- CoWShed / CoWShedForComposableCow factory addresses
- AaveV3AdapterFactory addresses per chain
- All handler addresses (TWAP, Stop Loss, Perpetual Swap, Good After Time, Trade Above Threshold)
- GPv2Settlement contract addresses per chain

---

## Key People / Contacts

- **Anxo** (@anxolin) - CoW Protocol core team, technical reviewer for this grant
- **Sasha** (CoW Front) - Frontend team, interested in streaming API (SSE/WS)
- **Martin** - Backend team, concerned about ETHFlow indexing technical debt
- **Leandro** - CoW Protocol team
- **Federico** - CoW Protocol, initial contact for smart contract discussions
- **MFW / mfw87** - Smart contract team, guidance on signature decoding
