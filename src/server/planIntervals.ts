import express from 'express';
import { getDb } from '../db/index.js';
import { resolveScopedAppIds } from '../sync/index.js';
import {
  listUsageChargeTypes,
  setUsageChargeKind,
  UsageChargeTypeError,
} from '../usage/chargeTypes.js';
import { listPlans, PlanIntervalError, setPlanInterval } from '../usage/planIntervals.js';
import { sendError } from './errors.js';

/**
 * The plan intervals API: each plan's billing interval, and the usage charge
 * names marked as exceptions to their plan.
 *
 * Plan names and charge names travel in the body rather than the path. They
 * are whatever an app chose to write — spaces, brackets, "#" — none of which
 * belongs in a route.
 */
export function planIntervalsRouter(): express.Router {
  const router = express.Router();

  router.get('/', (_request, response) => {
    try {
      const db = getDb();
      const apps = resolveScopedAppIds(db);
      response.json({ plans: listPlans(db, apps), charges: listUsageChargeTypes(db, apps) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/plan', (request, response) => {
    try {
      const body = request.body as { appId?: unknown; planName?: unknown; interval?: unknown };
      if (
        typeof body?.appId !== 'string' ||
        typeof body.planName !== 'string' ||
        typeof body.interval !== 'string'
      ) {
        throw new PlanIntervalError('Send "appId", "planName" and "interval" as strings.');
      }
      response.json(setPlanInterval(getDb(), body.appId, body.planName, body.interval));
    } catch (error) {
      reply(response, error);
    }
  });

  router.put('/charge', (request, response) => {
    try {
      const body = request.body as { appId?: unknown; key?: unknown; kind?: unknown };
      if (typeof body?.appId !== 'string' || typeof body.key !== 'string' || typeof body.kind !== 'string') {
        throw new UsageChargeTypeError('Send "appId", "key" and "kind" as strings.');
      }
      response.json(setUsageChargeKind(getDb(), body.appId, body.key, body.kind));
    } catch (error) {
      reply(response, error);
    }
  });

  return router;
}

function reply(response: express.Response, error: unknown): void {
  if (error instanceof PlanIntervalError || error instanceof UsageChargeTypeError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  sendError(response, error);
}
