import { relations } from "ponder";
import { conditionalOrder, discreteOrder } from "./tables";

export const conditionalOrderRelations = relations(
  conditionalOrder,
  ({ many }) => ({
    discreteOrders: many(discreteOrder),
  })
);

export const discreteOrderRelations = relations(discreteOrder, ({ one }) => ({
  conditionalOrder: one(conditionalOrder, {
    fields: [discreteOrder.conditionalOrderId],
    references: [conditionalOrder.id],
  }),
}));
