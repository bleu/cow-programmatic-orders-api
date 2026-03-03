# Programmatic Orders API

**Grant Program:** CoW Grants Program  
**Authors:** @bleu — @yvesfracari @ribeirojose @mendesfabio  
**Category:** Core Infrastructure & Developer Tooling  
**Total Duration:** 9 weeks  
**Technical Reviewer:** @anxolin (CoW Protocol core team)

---

## About

bleu collaborates with companies and DAOs as a web3 technology and user experience partner. We have completed 10+ grants for CoW Protocol, including a Framework-agnostic SDK, Hook dApps, Python SDK, AMM Deployer, and a Stop Loss Safe App — the latter of which included an API that tracks Composable CoW orders and decodes stop-loss ones.

---

## Problem

CoW Protocol supports two main types of programmatic orders:

- **Composable CoW orders:** Conditional orders like TWAP, Stop Loss, Perpetual Swap, Good After Time, and Trade Above Threshold
- **Flash loan orders:** AAVE integrations that use helper contracts deployed via pre-hooks

As programmatic orders become available to EOAs through CoWShedForComposableCow and other mechanisms, there is a growing need for unified indexing infrastructure. Currently, this creates three core problems:

1. **Lack of order visibility before OrderBook:** Programmatic orders only become visible in the CoW Protocol OrderBook when they are executable. There's no centralized way to track pending orders or display them to users beforehand.
2. **Difficult EOA mapping:** Each user interacts with Composable CoW through their own CoWShed proxy contract, making it hard to establish the relationship between the proxy address and the actual EOA owner.
3. **Flash loan order ownership tracking:** AAVE integrations use a pattern where an EOA places an order whose owner is an undeployed helper contract, later deployed in a pre-hook. This makes it harder to track the original owner and show trading history.

---

## Solution

A Ponder-based indexer and API providing queryable access to all programmatic order data. The API will:

- Index all Composable CoW orders on supported chains with real-time monitoring
- Decode all Composable CoW order types: TWAP, Stop Loss, Perpetual Swap, Good After Time, and Trade Above Threshold
- Track flash loan orders (AAVE integration) by linking deployed helper contracts to their rightful EOA owners
- Resolve ownership by integrating with CoWShed to map contract addresses to EOA owners
- Expose data via **GraphQL endpoints** with comprehensive querying capabilities

### Flash Loan Order Indexing Approach

Since there is no event that directly links a deployed helper contract to its original EOA owner, two approaches are used:

- **Solution 1 — Factory Event Monitoring:** Monitor `AaveV3AdapterFactory.deployAndTransferFlashLoan` calls. Requires call traces (not supported on all chains, expensive RPC calls).
- **Solution 2 — Trade Event Pattern Detection (fallback):** Listen to trade events and verify if the owner follows the helper contract pattern by calling specific ABI methods. Works on all chains.

### Unfilled / Expired Discrete Parts

For Composable CoW orders like TWAPs, discrete parts that don't execute won't produce a trade event, meaning they won't appear in the OrderBook. Rather than pre-generating all discrete parts ahead of time (which could be millions), the approach is to always attempt to generate the next expected part. This ensures full visibility of all parts — filled and unfilled — without unbounded computation, and removes this tracking responsibility from UIs like CoW Swap and Explorer.

### Orderbook Integration & Caching

Ponder automatically caches RPC calls, but has no built-in support for persistent off-chain data caching. On each new deploy, Ponder re-runs all event handlers to rebuild the database. Since some composable cow orders can generate infinite non-deterministic orders (e.g., perpetual swaps), a persistent cache layer for off-chain requests is critical. Composable CoW revert messages will also be leveraged to assist watchtower indexing, which is more efficient than fetching all orderbook orders from a user since the composable cow creation.

---

## Milestones

### 1. Composable CoW Tracking _(2 weeks)_

- Ponder indexer setup with PostgreSQL database
- Event listening for Composable CoW order creation and cancellation
- Historical backfilling and real-time monitoring
- Decoders for all five order types (TWAP, Stop Loss, Perpetual Swap, Good After Time, Trade Above Threshold)
- Integration of missing conditional orders (all except TWAP) into cow-sdk

### 2. Flash Loan Order Tracking & CoWShed Ownership Mapping _(1.5 weeks)_

- Flash loan order to EOA owner mapping (AAVE integration)
- Factory event monitoring via `AaveV3AdapterFactory.deployAndTransferFlashLoan`
- Trade event pattern detection as fallback
- CoWShedForComposableCow proxy to EOA owner mapping
- Tracking CoWShed proxy deployments and linking proxy contracts to their controlling EOAs

### 3. Orderbook Integration _(3 weeks)_

_(Updated from 4 weeks after forum discussion with @anxolin)_

- Pooling of historical and real-time orderbook data
- Matching of orderbook orders with their programmatic order generators
- Linking orders to their originating composable cow order
- Tracking execution status for Composable CoW orders
- Implementation of persistent off-chain cache layer to ensure data consistency across Ponder redeployments

### 4. Review & Documentation _(1.5 weeks)_

- Technical review with @anxolin (CoW Protocol core team) and bug fixing
- Complete API documentation (GraphQL schema, examples)
- Integration guides for frontend and third-party developers
- README documentation on how to run and deploy the application

---

## Grant Goals & Impact

- **CoW Swap Frontend Integration:** Enable the frontend to display all programmatic orders to users, providing full visibility into active, completed, and cancelled orders
- **EOA Support:** Unified way for regular wallet users to manage and monitor programmatic orders via CoWShedForComposableCow
- **Third-party Integration:** Developers can use the API to debug and track their own programmatic orders
- **Extensible Infrastructure:** Architecture ready to support new programmatic order types as they are developed

---

## Other Information

- All code will be open-source from day 0
- The indexer will be deployed for testing during development and **handed off to the CoW Protocol team after grant conclusion**
- RPC costs to be covered by CoW Protocol via private RPC connection links
- Close collaboration planned with the CoW Swap frontend team to ensure API meets their display requirements
- For the Orderbook integration, access to the current auction endpoints of the API will be required

---

## Important Links

- 📋 [Grant Application (CoW Forum)](https://forum.cow.fi/t/grant-application-programmatic-orders-api/3346)
- 📦 [Composable CoW Repository](https://github.com/cowprotocol/composable-cow)
- 🔗 [ERC1271Forwarder Contract](https://github.com/cowprotocol/composable-cow/blob/main/src/ERC1271Forwarder.sol#L30)
- 📖 [CoW Protocol Programmatic Orders Docs](https://docs.cow.fi/cow-protocol/concepts/order-types/programmatic-orders)
- 🧩 [GraphQL Schema Draft (dbdiagram.io)](https://dbdiagram.io)
