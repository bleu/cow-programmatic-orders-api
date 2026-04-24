import {
  DocMap,
  generatePageDocs,
  generateQueryDocs,
} from "ponder-enrich-gql-docs-middleware";

export const ownerMappingDocs: DocMap = {
  ownerMapping:
    "Maps proxy/adapter contract addresses to their underlying EOA. Used to resolve resolvedOwner on conditional order generators created through CoWShed proxies or Aave flash loan adapters.",
  "ownerMapping.address":
    "Proxy or adapter contract address. Part of the composite primary key with chainId.",
  "ownerMapping.chainId": "EVM chain ID.",
  "ownerMapping.owner":
    "Fully resolved EOA owner. Never an intermediate proxy address.",
  "ownerMapping.addressType": "cowshed_proxy or flash_loan_helper.",
  "ownerMapping.txHash":
    "Transaction where this mapping was discovered.",
  "ownerMapping.blockNumber": "Block number of discovery.",
  "ownerMapping.resolutionDepth":
    "Hops walked to reach the EOA. 0 for direct CoWShed mappings, 1 for Aave adapters (requires an extra owner() call).",

  ...generatePageDocs("ownerMapping", "owner mapping"),
  ...generateQueryDocs("ownerMapping", "owner mapping"),
};
