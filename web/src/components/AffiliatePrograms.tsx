import { useEffect, useMemo, useState } from 'react';
import {
  fetchAffiliatePrograms,
  fetchAffiliateSetup,
  fetchListings,
  fetchProgram,
  type AffiliateProgram,
  type AppListing,
  type ProgramDetail,
} from '../api';
import { formatValue } from '../format';
import { formatDuration, formatRate, loadReferralFeed, type ReferralFeed } from './AffiliateData';
import { CopyButton, LoadState, Stat } from './AffiliateCommon';
import { signupUrl } from '../portal/publicRoutes';
import { AffiliateProgramForm } from './AffiliateProgramForm';
import { AffiliateSetupCard } from './AffiliateSetup';

/**
 * The programs and their terms.
 *
 * A handful of programs, so each is a card rather than a row: the question is
 * never "which of these has the highest rate", it is "what exactly did we
 * promise the people in this one". That answer is the terms table, and it is
 * the one thing on this page that may not be shortened away — an operator has
 * to be able to read what a program pays without opening the source.
 *
 * Every term is a cell. None of them is a sentence.
 *
 * The listing URL is not on the program record. It comes from `/api/listings`,
 * the same mapping the referral redirect follows.
 *
 * ## The invite link
 *
 * The one thing on this page an operator does something with. Creating a
 * program used to produce nothing shareable: the public signup page lists every
 * open program and has no id in its URL, and no screen printed even that URL, so
 * "I made a program, how do people join it" had no answer inside the product.
 * The link below each card is that answer — the signup page with this program
 * named, so an applicant who follows it arrives with the right one already
 * ticked.
 *
 * It is not a credential and is not secret. It preselects; the server still
 * decides what the program costs, whether it needs approval, and whether it is
 * open at all. A closed program therefore shows no link rather than one that
 * would greet whoever clicked it with a refusal.
 */

function Term({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  );
}

/** Absent rather than empty: a term the API does not report is not "none". */
const NOT_REPORTED = <span className="muted-cell">Not reported</span>;

/**
 * Where an applicant is sent to join one program.
 *
 * `PORTAL_BASE_URL` is the authority when it is set, because it is the only
 * value that knows this install's public name: behind a proxy the dashboard's
 * own origin can be an internal host, and a link built from it works for the
 * operator who copied it and for nobody they send it to. It is unset on a fresh
 * install, so the origin is the fallback rather than an empty string — a link
 * that is probably right beats a link that is certainly broken, and the setup
 * card already asks for the variable by name.
 *
 * The URL itself comes from `signupUrl`, which sits next to the router that
 * parses it back — so the link this mints and the link that is read cannot
 * drift apart.
 */
function programInviteUrl(portalBaseUrl: string, programId: string): string {
  return signupUrl(portalBaseUrl || window.location.origin, programId);
}

function ProgramCard({
  program,
  listing,
  feed,
  portalBaseUrl,
  onEdit,
}: {
  program: AffiliateProgram;
  listing: AppListing | undefined;
  feed: ReferralFeed | null;
  portalBaseUrl: string;
  onEdit: () => void;
}) {
  const stats = useMemo(() => {
    if (!feed) return null;
    const rows = feed.rows.filter((row) => row.programId === program.id);
    return {
      referrals: rows.length,
      live: rows.filter((row) => !row.unassignedAt).length,
      earned: rows.reduce((sum, row) => sum + row.earned, 0),
      commissions: rows.reduce((sum, row) => sum + row.commissions, 0),
    };
  }, [feed, program.id]);

  return (
    <section className="card full">
      {/* The program's name is the title of the card, not a field label on it.
          No subtitle under it: the rate and the duration were repeated there
          and are two rows of the terms table below. */}
      <div className="card-label program-name">
        {program.name}{' '}
        <span className={`pill ${program.status === 'active' ? 'pill-paying' : ''}`.trim()}>
          {program.status === 'active' ? 'Active' : 'Closed'}
        </span>{' '}
        <button type="button" onClick={onEdit}>
          Edit
        </button>
      </div>

      <div className="stat-row">
        <Stat label="Enrolled" value={program.affiliates.toLocaleString()} />
        <Stat
          label="Referrals"
          value={stats ? stats.referrals.toLocaleString() : '—'}
          note={stats ? `${stats.live.toLocaleString()} live` : null}
        />
        <Stat
          label="Lifetime commission"
          value={stats ? formatValue(stats.earned, 'money', 'USD') : '—'}
          note={stats ? `${stats.commissions.toLocaleString()} commissions` : null}
        />
        <Stat label="Approval" value={program.requiresApproval ? 'Required' : 'Automatic'} />
      </div>

      {/*
        The invite link, above the terms because it is the thing an operator
        opened this page to get and the terms are what they check afterwards.
        Shown in full rather than behind the button alone: it goes into an email
        somebody writes, and a link you cannot read before sending is one you
        send wrong.
      */}
      <div className="channel-note">
        {program.status === 'active' ? (
          <>
            <span className="muted-cell">{programInviteUrl(portalBaseUrl, program.id)}</span>{' '}
            <CopyButton
              value={programInviteUrl(portalBaseUrl, program.id)}
              label="Copy invite link"
              title="The signup page with this programme preselected"
            />
          </>
        ) : (
          <span className="muted-cell">
            Closed programmes take no applications, so there is no invite link. Reopen it from
            Edit to hand one out.
          </span>
        )}
      </div>

      {/*
        The terms. Load-bearing, and the reason this page is not just four
        tiles: an operator answering "what does this program pay" needs the
        rate, what it applies to, how long it runs and from when, when a
        referral is released after an uninstall, and what a refund does. All
        six are here as values, and the refund rule is the one that is the same
        for every program — stated once, in its own row, rather than left off
        because it never varies.
      */}
      <div className="table-wrap">
        <table className="program-terms">
          <tbody>
            <Term label="Rate" value={`${formatRate(program.commissionRate)} of gross`} />
            <Term
              label="Earns on"
              value={
                program.revenueComponents?.length
                  ? `${program.revenueComponents.join(', ')} charges`
                  : NOT_REPORTED
              }
            />
            <Term
              label="Duration"
              value={
                program.durationMonths === null
                  ? 'No cut-off'
                  : `${formatDuration(program.durationMonths)} from the first commission on a merchant`
              }
            />
            <Term
              label="Released after uninstall"
              value={
                program.unassignAfterUninstallDays === undefined
                  ? NOT_REPORTED
                  : program.unassignAfterUninstallDays === null
                    ? 'Never'
                    : `${program.unassignAfterUninstallDays} days`
              }
            />
            {/* Said as what the engine does, not as what a programme sounds
                like it should do. A refund arrives as a sale with negative
                gross and is skipped; no negative commission is ever written,
                and no earned commission is reversed. The previous wording
                promised a clawback this system deliberately does not perform. */}
            <Term label="Refunds" value="Earn nothing; earned commission is not reversed" />
            <Term
              label="Listing"
              value={
                listing ? (
                  <a
                    className="customer-domain-link"
                    href={listing.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {listing.url}
                  </a>
                ) : (
                  <span className="muted-cell" title="Add one under Settings → App listings.">
                    None mapped — referral links have nowhere to send a click
                  </span>
                )
              }
            />
            <Term
              label="App"
              value={
                program.appId ? (
                  <code>{program.appId}</code>
                ) : (
                  <span className="muted-cell">Not linked yet</span>
                )
              }
            />
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AffiliatePrograms() {
  const [programs, setPrograms] = useState<AffiliateProgram[] | null>(null);
  const [listings, setListings] = useState<AppListing[]>([]);
  const [feed, setFeed] = useState<ReferralFeed | null>(null);
  /**
   * Only `portalBaseUrl` is wanted here, and only for the invite links. Empty
   * until it arrives, which `programInviteUrl` reads as "fall back to this
   * origin" — so a slow or failed read costs a link that is right on most
   * installs, not a card with a blank where the link goes.
   */
  const [portalBaseUrl, setPortalBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The programme being edited, `'new'` for the create form, or null. */
  const [editing, setEditing] = useState<ProgramDetail | 'new' | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchAffiliatePrograms()
      .then((result) => {
        if (!cancelled) setPrograms(result.programs);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });

    // The listing mapping is a nicety, not the page: an install with none still
    // has programs worth reading, so a failure here is silent.
    fetchListings()
      .then((result) => {
        if (!cancelled) setListings(result.listings);
      })
      .catch(() => undefined);

    fetchAffiliateSetup()
      .then((result) => {
        if (!cancelled) setPortalBaseUrl(result.setup.portalBaseUrl);
      })
      .catch(() => undefined);

    // Referral and commission counts per program. Shared with the Referrals
    // page, so whichever is opened first pays for both.
    loadReferralFeed()
      .then((result) => {
        if (!cancelled) setFeed(result);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [reload]);

  const byApp = useMemo(() => {
    const map = new Map<string, AppListing>();
    for (const listing of listings) map.set(listing.appId, listing);
    return map;
  }, [listings]);

  const saved = (): void => {
    setEditing(null);
    setReload((count) => count + 1);
  };

  if (editing === 'new') {
    return <AffiliateProgramForm onSaved={saved} onCancel={() => setEditing(null)} />;
  }
  if (editing) {
    return (
      <AffiliateProgramForm
        program={editing}
        onSaved={saved}
        onCancel={() => setEditing(null)}
        key={editing.id}
      />
    );
  }

  return (
    <>
      <AffiliateSetupCard key={reload} />

      <div className="channel-actions">
        <button type="button" className="primary" onClick={() => setEditing('new')}>
          New programme
        </button>
      </div>

      <LoadState
        loading={programs === null}
        error={error}
        empty={(programs?.length ?? 0) === 0}
        loadingLabel="Loading programs…"
        // The empty state used to read "they arrive with the affiliate import",
        // which is true of exactly one deployment and a dead end for every
        // other. The button above it is the answer now, so this only has to say
        // what a programme is for.
        errorTitle="Could not load programs"
        emptyMessage="No programmes yet. One holds the rate, what it earns on, and how long a referral runs."
      >
        {(programs ?? []).map((program) => (
          <ProgramCard
            key={program.id}
            program={program}
            listing={byApp.get(program.appId)}
            feed={feed}
            portalBaseUrl={portalBaseUrl}
            onEdit={() => {
              // Read the full record rather than promoting the list row: the
              // list carries a summary, and an edit form seeded from it would
              // silently blank every field the summary omits.
              fetchProgram(program.id)
                .then((result) => setEditing(result.program))
                .catch((cause: Error) => setError(cause.message));
            }}
          />
        ))}
      </LoadState>
    </>
  );
}
