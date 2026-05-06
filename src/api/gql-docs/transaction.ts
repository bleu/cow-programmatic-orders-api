import {
  DocMap,
  generatePageDocs,
  generateQueryDocs,
} from "ponder-enrich-gql-docs-middleware";

export const transactionDocs: DocMap = {
  transaction:
    "Block metadata for indexed transactions. Multiple events in the same transaction share a row.",
  "transaction.hash":
    "Transaction hash. Part of the composite primary key with chainId.",
  "transaction.chainId": "EVM chain ID.",
  "transaction.blockNumber": "Block number where this transaction was mined.",
  "transaction.blockTimestamp": "Unix timestamp (seconds) of the block.",

  ...generatePageDocs("transaction", "transaction"),
  ...generateQueryDocs("transaction", "transaction"),
};
