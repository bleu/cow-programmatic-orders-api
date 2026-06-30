/**
 * Block handlers — one file per handler under ./block. This barrel imports them
 * so their ponder.on(...) registrations run. See ./block/<name>.ts.
 */
import "./block/orderDiscoveryPoller";
import "./block/candidateConfirmer";
import "./block/orderStatusTracker";
import "./block/flashLoanOrderBackfiller";
import "./block/flashLoanOrderEnricher";
import "./block/ownerBackfill";
import "./block/cancellationWatcher";
