import { relations } from "ponder";
import { conditionalOrder, orders } from "./tables";

export const conditionalOrderRelations = relations(
  conditionalOrder,
  ({ many }) => ({
    orders: many(orders),
  })
);

export const ordersRelations = relations(orders, ({ one }) => ({
  conditionalOrder: one(conditionalOrder, {
    fields: [orders.conditionalOrderId],
    references: [conditionalOrder.id],
  }),
}));
