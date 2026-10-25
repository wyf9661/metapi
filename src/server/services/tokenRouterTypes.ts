/**
 * Row/candidate shapes owned by the token router.
 *
 * These used to live inside `tokenRouter.ts`, which made every helper that
 * touches a candidate unextractable: the router's own modules could not name the
 * type without importing the whole router back. They are pure type declarations
 * (no runtime code), so both the router and its helpers can import them freely.
 *
 * Import cycle note: this file imports only the db schema and the shared route
 * contract, both of which are leaves.
 */
import { schema } from '../db/index.js';
import type { RouteMode } from '../../shared/tokenRouteContract.js';

export interface RouteMatch {
  route: RouteRow;
  channels: Array<{
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    site: typeof schema.sites.$inferSelect;
    token: typeof schema.accountTokens.$inferSelect | null;
  }>;
}

export type RouteChannelCandidate = RouteMatch['channels'][number];

export type RouteRow = typeof schema.tokenRoutes.$inferSelect & {
  routeMode: RouteMode;
  sourceRouteIds: number[];
};
export type ChannelRow = typeof schema.routeChannels.$inferSelect;
