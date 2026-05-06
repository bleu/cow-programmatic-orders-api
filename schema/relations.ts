import { relations } from "ponder";
import { candidateDiscreteOrder, conditionalOrderGenerator, discreteOrder, transaction } from "./tables";

export const transactionRelations = relations(transaction, ({ many }) => ({
  conditionalOrderGenerators: many(conditionalOrderGenerator),
}));

export const conditionalOrderGeneratorRelations = relations(
  conditionalOrderGenerator,
  ({ one, many }) => ({
    transaction: one(transaction, {
      fields: [conditionalOrderGenerator.chainId, conditionalOrderGenerator.txHash],
      references: [transaction.chainId, transaction.hash],
    }),
    discreteOrders: many(discreteOrder),
    candidateDiscreteOrders: many(candidateDiscreteOrder),
  })
);

export const discreteOrderRelations = relations(discreteOrder, ({ one }) => ({
  conditionalOrderGenerator: one(conditionalOrderGenerator, {
    fields: [discreteOrder.chainId, discreteOrder.conditionalOrderGeneratorId],
    references: [conditionalOrderGenerator.chainId, conditionalOrderGenerator.eventId],
  }),
}));

export const candidateDiscreteOrderRelations = relations(candidateDiscreteOrder, ({ one }) => ({
  conditionalOrderGenerator: one(conditionalOrderGenerator, {
    fields: [candidateDiscreteOrder.chainId, candidateDiscreteOrder.conditionalOrderGeneratorId],
    references: [conditionalOrderGenerator.chainId, conditionalOrderGenerator.eventId],
  }),
}));
