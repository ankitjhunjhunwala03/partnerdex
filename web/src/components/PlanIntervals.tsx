import { useEffect, useState } from 'react';
import {
  fetchPlanIntervals,
  saveChargeException,
  savePlanInterval,
  type PlanInterval,
  type PlanIntervalSettings,
  type PlanRow,
  type UsageChargeKind,
  type UsageChargeType,
} from '../api';

/**
 * The two decisions MRR needs from the partner, and nothing else.
 *
 * 1. Which plans billed through usage charges bill yearly. Shopify states a
 *    priced plan's interval itself, so only the zero-priced plans are asked
 *    about; an unset one shows its default (yearly where ANNUAL_PLAN_PATTERN
 *    matches its name, monthly otherwise).
 * 2. What to do with the charges whose own name disagrees with the plan they
 *    were billed on — a yearly fee on a monthly plan, or a one-off such as
 *    custom work. Only those are listed; every other charge follows its plan.
 *    A name already decided stays listed, so the decision can be undone.
 */

const COUNTS_AS: Array<{ value: 'plan' | UsageChargeKind; label: string }> = [
  { value: 'plan', label: 'Follow plan' },
  { value: 'monthly', label: 'Monthly fee' },
  { value: 'annual', label: 'Yearly fee' },
  { value: 'metered', label: 'Metered usage' },
  { value: 'one_off', label: 'One-off (not MRR)' },
];

function PlanLine({ plan, onSaved }: { plan: PlanRow; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (value: PlanInterval) => {
    setBusy(true);
    setError(null);
    try {
      await savePlanInterval(plan.appId, plan.planName, value);
      onSaved();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td data-label="Plan">
        {plan.planName}
        {error ? <p className="channel-status bad">{error}</p> : null}
      </td>
      <td className="num" data-label="Shops">
        {plan.shops.toLocaleString()} {plan.shops === 1 ? 'shop' : 'shops'}
      </td>
      <td data-label="Bills">
        <select
          aria-label={`How "${plan.planName}" bills`}
          value={plan.interval}
          disabled={busy}
          onChange={(event) => void change(event.target.value as PlanInterval)}
        >
          <option value="monthly">Monthly</option>
          <option value="annual">Yearly</option>
        </select>
      </td>
    </tr>
  );
}

/** "billed on X", or "billed on X and Y" where a name spans plans. */
function billedOn(charge: UsageChargeType): string {
  const names = [...new Set(charge.plans.map((plan) => plan.planName ?? 'no live plan'))];
  if (names.length <= 2) return `billed on ${names.join(' and ')}`;
  return `billed on ${names[0]} and ${names.length - 1} other plans`;
}

function ChargeLine({
  charge,
  onSaved,
}: {
  charge: UsageChargeType;
  onSaved: (next: UsageChargeType) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (kind: 'plan' | UsageChargeKind) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveChargeException(charge.appId, charge.key, kind);
      onSaved({ ...charge, kind: saved.kind, source: saved.source });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td data-label="Charge" title={charge.key}>
        {charge.exampleName}
        <div className="card-subtitle">{billedOn(charge)}</div>
        {error ? <p className="channel-status bad">{error}</p> : null}
      </td>
      <td data-label="Counts as">
        <select
          aria-label={`How "${charge.exampleName}" counts`}
          value={charge.kind}
          disabled={busy}
          onChange={(event) => void change(event.target.value as 'plan' | UsageChargeKind)}
        >
          {COUNTS_AS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );
}

export function PlanIntervals() {
  const [settings, setSettings] = useState<PlanIntervalSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetchPlanIntervals()
      .then(setSettings)
      .catch((cause: Error) => setError(cause.message));

  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load plans</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!settings) return <div className="skeleton">Loading plans…</div>;

  // A zero-priced plan that has never billed anything (a free tier) has no
  // interval worth asking about; one already set stays, so it can be undone.
  const plans = settings.plans.filter(
    (plan) => !plan.priced && (plan.billed || plan.basis === 'setting'),
  );
  // A name stays on the list once decided, so the decision can be undone.
  const charges = settings.charges.filter(
    (charge) => charge.needsReview || charge.kind !== 'plan',
  );
  const replaceCharge = (next: UsageChargeType) =>
    setSettings((current) =>
      current
        ? {
            ...current,
            charges: current.charges.map((charge) =>
              charge.appId === next.appId && charge.key === next.key ? next : charge,
            ),
          }
        : current,
    );

  return (
    <>
      <div className="card full">
        <div className="card-head">
          <span className="card-label">Plans billed through usage</span>
          <span className="card-subtitle">
            Shopify can't tell whether these bill monthly or yearly. Tell us which bill yearly.
          </span>
        </div>
        {plans.length === 0 ? (
          <p className="footnote">No plans billed through usage.</p>
        ) : (
          <div className="table-wrap">
            <table className="affiliate-table">
              <tbody>
                {plans.map((plan) => (
                  <PlanLine
                    key={`${plan.appId} ${plan.planName}`}
                    plan={plan}
                    onSaved={() => void load()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card full">
        <div className="card-head">
          <span className="card-label">Charges that don't match their plan</span>
          <span className="card-subtitle">
            Every other charge counts the way its plan does. Choose how each of these should count
            in MRR.
          </span>
        </div>
        {charges.length === 0 ? (
          <p className="footnote">Every charge matches its plan. Nothing to decide.</p>
        ) : (
          <div className="table-wrap">
            <table className="affiliate-table">
              <tbody>
                {charges.map((charge) => (
                  <ChargeLine
                    key={`${charge.appId} ${charge.key}`}
                    charge={charge}
                    onSaved={replaceCharge}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
