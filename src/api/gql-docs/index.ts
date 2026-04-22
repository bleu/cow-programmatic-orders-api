import type { Context, Next } from "hono";
import {
  createDocumentationMiddleware,
  extendWithBaseDefinitions,
} from "ponder-enrich-gql-docs-middleware";
import { conditionalOrderGeneratorDocs } from "./conditional-order-generator";
import { discreteOrderDocs } from "./discrete-order";
import { transactionDocs } from "./transaction";
import { ownerMappingDocs } from "./owner-mapping";

const docs = extendWithBaseDefinitions({
  ...conditionalOrderGeneratorDocs,
  ...discreteOrderDocs,
  ...transactionDocs,
  ...ownerMappingDocs,
});

const _docsMiddleware = createDocumentationMiddleware(docs);

export const gqlDocsMiddleware = async (c: Context, next: Next) => {
  let nextCalled = false;
  const wrappedNext: Next = async () => {
    nextCalled = true;
    await next();
  };

  try {
    await _docsMiddleware(c, wrappedNext);
    // Hono's res setter preserves content-length from the previous response.
    // When the middleware replaces the body with the enriched introspection
    // payload, the old (smaller) content-length would truncate the response.
    c.header("content-length", undefined);
  } catch {
    if (!nextCalled) await next();
  }
};
