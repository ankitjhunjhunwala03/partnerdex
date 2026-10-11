import { InfoTip } from '../components/InfoTip';
import { formatFullDate } from '../format';
import type { Program } from './api';
import { ReferralLink, safeUrl } from './ReferralLink';
import { sharedTerms, statusCopy, termsFor } from './terms';

/**
 * What each program pays, in values an affiliate can check their own statement
 * against.
 *
 * This page exists because "20%" on its own is not a term. Twenty per cent of
 * what, on which charges, for how long, and what happens when the merchant
 * leaves — those four are the difference between an affiliate who can predict
 * their earnings and one who opens a support ticket every month.
 *
 * All four are still here, and so is the fifth (a refund takes the commission
 * back). What changed is the shape: they were a card of five bullet points per
 * program and are now one row per program in a terms table, with the rules that
 * are the same everywhere stated once underneath instead of repeated per card.
 */

export function Programs({ programs }: { programs: Program[] }) {
  if (programs.length === 0) {
    return (
      <section className="portal-section">
        <p className="portal-hint portal-note">
          You are not enrolled in an affiliate program. Get in touch and we will set you up with a
          link.
        </p>
      </section>
    );
  }

  const linkable = programs.filter((program) => safeUrl(program.referralUrl));
  const waiting = programs.filter((program) => !safeUrl(program.referralUrl));

  return (
    <section className="portal-section">
      <div className="table-wrap">
        <table className="terms-table">
          <thead>
            <tr>
              <th>Program</th>
              <th>
                Status
                <InfoTip label="Status">
                  Active means installs through your link are credited to you. Awaiting approval or
                  Not approved means they cannot be yet.
                </InfoTip>
              </th>
              <th>
                Commission
                <InfoTip label="Commission">
                  The share of each qualifying charge you earn. Gross means the full amount the
                  merchant pays, before Shopify’s cut and ours.
                </InfoTip>
              </th>
              <th>
                Earns on
                <InfoTip label="Earns on">
                  Which of the merchant’s charges earn you commission, such as their subscription.
                  Other charges earn nothing.
                </InfoTip>
              </th>
              <th>
                Duration
                <InfoTip label="Duration">
                  How long you keep earning on each merchant. The clock starts at your first
                  commission on that merchant, not the day they installed.
                </InfoTip>
              </th>
              <th>
                Handle
                <InfoTip label="Handle">
                  Your code inside the referral link. It is how a click on your link is recognised
                  as yours.
                </InfoTip>
              </th>
            </tr>
          </thead>
          <tbody>
            {programs.map((program) => {
              const copy = statusCopy(program.status);
              const terms = termsFor(program);
              return (
                <tr key={program.programId}>
                  <td data-label="Program">
                    {program.programName}
                    <span className="row-hint always">
                      {program.approvedAt ? 'Approved' : 'Applied'}{' '}
                      {formatFullDate(program.approvedAt || program.joinedAt)}
                    </span>
                  </td>
                  <td data-label="Status">
                    <span className={`pill pill-${copy.tone}`}>{copy.label}</span>
                  </td>
                  <td data-label="Commission">{terms.rate}</td>
                  <td data-label="Earns on">{terms.earnsOn}</td>
                  <td data-label="Duration">
                    {terms.duration}
                    {/* The qualifier is the term, not a footnote to it: the cap
                        is counted from the first commission on a merchant, not
                        from the day they installed. */}
                    {terms.durationFrom ? (
                      <span className="row-hint always">{terms.durationFrom}</span>
                    ) : null}
                  </td>
                  <td data-label="Handle">
                    {/* Rendered as text, never interpolated into markup or a
                        URL. Handles come from the imported Mantle records and
                        are not ours to trust; React escapes this, and the link
                        below is the one the server built and validated. */}
                    <code>{program.handle}</code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {linkable.length > 0 ? (
        <div className="portal-links">
          {linkable.map((program) => (
            <div className="portal-link-row" key={program.programId}>
              <span className="stat-label">
                {program.programName}
                <InfoTip label="Referral link">
                  Share this link. A merchant who clicks it and installs the app soon after, on the
                  same device and browser, is credited to you.
                </InfoTip>
              </span>
              <ReferralLink url={safeUrl(program.referralUrl) as string} label={program.programName} />
            </div>
          ))}
        </div>
      ) : null}

      {/* A membership with no link cannot earn, and is told so rather than left
          to be inferred from a missing control. */}
      {waiting.map((program) => (
        <p className="portal-hint portal-note" key={program.programId}>
          <span className={`pill pill-${statusCopy(program.status).tone}`}>
            {statusCopy(program.status).label}
          </span>{' '}
          {program.programName} — {statusCopy(program.status).meaning}
        </p>
      ))}

      <ul className="portal-terms">
        {sharedTerms(programs).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}
