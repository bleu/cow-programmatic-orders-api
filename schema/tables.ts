import { index, onchainTable } from "ponder";

export const conditionalOrder = onchainTable(
  "conditionalOrder",
  (t) => ({
    id: t.text().primaryKey(),
    owner: t.text().notNull(),
    handler: t.text().notNull(),
    salt: t.text().notNull(),
    staticInput: t.text().notNull(),
    hash: t.text().notNull(),
    txHash: t.text().notNull(),
  }),
  (t) => ({
    ownerIdx: index().on(t.owner),
    handlerIdx: index().on(t.handler),
  })
);

export const orders = onchainTable("orders", (t) => ({
  orderUid: t.text().primaryKey(),
  conditionalOrderId: t.text().notNull(),
}));
