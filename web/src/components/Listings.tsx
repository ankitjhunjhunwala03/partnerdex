import { useCallback, useEffect, useState } from 'react';
import {
  checkListing,
  deleteListing,
  fetchListings,
  saveListing,
  type AppListing,
  type ListingSettings,
} from '../api';
import { formatDateTime } from '../format';
import { InfoTip } from './InfoTip';

/**
 * Which App Store listing belongs to which app.
 *
 * This exists because nothing in the Partner API connects the two. An
 * organization has many apps; each is published under a slug that only the
 * partner knows, and until they say so there is no way to read a single review.
 *
 * The page is built around the one mistake that is otherwise invisible: pasting
 * the wrong listing. A bad URL costs nothing when it is saved and everything at
 * sync time, where it surfaces days later as an app that mysteriously has no
 * reviews — so **Check** fetches the page and shows the app name the listing
 * itself claims, which is the only confirmation that means anything.
 */

const URL_PLACEHOLDER = 'https://apps.shopify.com/your-app-handle';

function ListingRow({
  listing,
  onChanged,
  onRemoved,
}: {
  listing: AppListing;
  onChanged: (next: AppListing) => void;
  onRemoved: (appId: string) => void;
}) {
  const [url, setUrl] = useState(listing.url);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // A listing edited elsewhere — or re-read after a check — must not be
  // overwritten by whatever is sitting in this input.
  useEffect(() => {
    setUrl(listing.url);
  }, [listing.url]);

  const save = async () => {
    setBusy('save');
    setError(null);
    setNote(null);
    try {
      onChanged(await saveListing(listing.appId, url));
      setNote('Saved.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy('check');
    setError(null);
    setNote(null);
    try {
      const next = await checkListing(listing.appId);
      onChanged(next);
      if (next.lastError) setError(next.lastError);
      else if (next.listingName) setNote(`That listing is “${next.listingName}”.`);
      else setNote('The listing responded.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    setError(null);
    try {
      await deleteListing(listing.appId);
      onRemoved(listing.appId);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(null);
    }
  };

  const dirty = url.trim() !== listing.url;

  return (
    <li className="channel">
      <div className="channel-head">
        <span className="channel-name">{listing.appName ?? `App ${listing.appId}`}</span>
        <span className="channel-note">
          {listing.reviewCount > 0
            ? `${listing.reviewCount.toLocaleString()} review${listing.reviewCount === 1 ? '' : 's'} collected`
            : 'No reviews collected yet'}
          <InfoTip label="Reviews collected">
            How many reviews of this app have been read from its listing so far, including ones the
            listing no longer shows. New ones arrive with each sync.
          </InfoTip>
        </span>
        {/* Where the value came from, because a row seeded from the environment
            behaves differently: editing it here takes ownership of it. */}
        {listing.source === 'config' ? (
          <span className="pill" title="Seeded from APP_STORE_HANDLES. Saving here takes it over.">
            From env
          </span>
        ) : null}
        {listing.source === 'config' ? (
          <InfoTip label="From env">
            This mapping came from the APP_STORE_HANDLES environment variable. Saving a change here
            takes it over, and the dashboard's value is used from then on.
          </InfoTip>
        ) : null}
      </div>

      <div className="field-row">
        <div className="control control-grow">
          <label htmlFor={`listing-${listing.appId}`}>
            Listing URL
            <InfoTip label="Listing URL">
              This app's page on the Shopify App Store. Reviews are read from it on every sync; use
              Check to confirm it is the right app before relying on it.
            </InfoTip>
          </label>
          <input
            id={`listing-${listing.appId}`}
            type="text"
            value={url}
            placeholder={URL_PLACEHOLDER}
            onChange={(event) => setUrl(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="channel-actions">
          <button type="button" className="primary" onClick={save} disabled={busy !== null || !dirty}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={check} disabled={busy !== null}>
            {busy === 'check' ? 'Checking…' : 'Check'}
          </button>
          {confirmingRemove ? (
            <>
              <button type="button" className="danger" onClick={remove} disabled={busy !== null}>
                {busy === 'remove' ? 'Removing…' : 'Confirm'}
              </button>
              <button type="button" onClick={() => setConfirmingRemove(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmingRemove(true)} disabled={busy !== null}>
              Remove
            </button>
          )}
        </div>
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}
      {note ? <p className="channel-status good">{note}</p> : null}

      {!error && !note && listing.checkedAt ? (
        // A check that failed and stayed failed has to keep looking failed on
        // reload; muted grey reads as "fine, and old".
        <p className={listing.lastError ? 'channel-status bad' : 'channel-status'}>
          {listing.lastError
            ? `Last check failed ${formatDateTime(listing.checkedAt)}: ${listing.lastError}`
            : `${listing.listingName ? `“${listing.listingName}” · ` : ''}checked ${formatDateTime(
                listing.checkedAt,
              )}`}
        </p>
      ) : null}

      {confirmingRemove ? (
        // Said plainly, because the opposite is what a reader would assume.
        <p className="footnote">
          Removing the mapping stops the crawl. The reviews already collected are kept — for the
          removed ones this is the only copy that still exists.
        </p>
      ) : null}
    </li>
  );
}

function AddListing({
  apps,
  onAdded,
}: {
  apps: Array<{ id: string; name: string }>;
  onAdded: (listing: AppListing) => void;
}) {
  const [appId, setAppId] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onAdded(await saveListing(appId, url));
      setAppId('');
      setUrl('');
      setOther(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card full channel-form" onSubmit={submit}>
      <h2 className="card-label">Add a listing</h2>
      <p className="card-subtitle">
        Open your app on the App Store and copy the address. Everything from{' '}
        <code>https://apps.shopify.com/your-app</code> to the full URL with a{' '}
        <code>/reviews</code> path on the end works — only the handle is kept.
      </p>

      <div className="field-row">
        <div className="control">
          <label htmlFor="listing-app">
            App
            <InfoTip label="App">
              The app from your Partner account that this listing belongs to. Choose Another app id
              for an app that has no billing activity yet.
            </InfoTip>
          </label>
          {other || apps.length === 0 ? (
            <input
              id="listing-app"
              type="text"
              placeholder="App id"
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              autoComplete="off"
              required
            />
          ) : (
            <select
              id="listing-app"
              value={appId}
              onChange={(event) => {
                // An app with no transactions yet never reaches the `apps`
                // table, and it still has a listing worth watching.
                if (event.target.value === '__other') {
                  setOther(true);
                  setAppId('');
                } else {
                  setAppId(event.target.value);
                }
              }}
              required
            >
              <option value="">Choose an app…</option>
              {apps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                </option>
              ))}
              <option value="__other">Another app id…</option>
            </select>
          )}
        </div>

        <div className="control control-grow">
          <label htmlFor="listing-url">
            Listing URL
            <InfoTip label="Listing URL">
              The app's address on apps.shopify.com. Only the handle is kept, so any page of the
              listing works. Reviews start arriving with the next sync.
            </InfoTip>
          </label>
          <input
            id="listing-url"
            type="text"
            placeholder={URL_PLACEHOLDER}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>

        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Adding…' : 'Add listing'}
        </button>
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}
    </form>
  );
}

export function Listings() {
  const [settings, setSettings] = useState<ListingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchListings()
      .then((result) => {
        if (!cancelled) setSettings(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const replace = useCallback((next: AppListing) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            listings: current.listings.some((entry) => entry.appId === next.appId)
              ? current.listings.map((entry) => (entry.appId === next.appId ? next : entry))
              : [...current.listings, next],
          }
        : current,
    );
  }, []);

  const drop = useCallback((appId: string) => {
    setSettings((current) =>
      current
        ? { ...current, listings: current.listings.filter((entry) => entry.appId !== appId) }
        : current,
    );
  }, []);

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load listings</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!settings) return <div className="skeleton">Loading listings…</div>;

  const mapped = new Set(settings.listings.map((listing) => listing.appId));
  const unmapped = settings.apps.filter((app) => !mapped.has(app.id));

  return (
    <>
      {settings.listings.length === 0 ? (
        <div className="notice">
          <h2>No listings mapped yet</h2>
          <p>
            The Partner API carries no review data and cannot say which App Store page an app is
            published under. Map an app to its listing below and reviews start arriving with the
            next sync.
          </p>
        </div>
      ) : (
        <div className="card full">
          <div className="card-head">
            <span className="card-label">Mapped listings</span>
            <span className="card-subtitle">
              One listing per app. Reviews, and anything else the listing page can tell us, are read
              from these.
            </span>
          </div>
          <ul className="channel-list">
            {settings.listings.map((listing) => (
              <ListingRow
                key={listing.appId}
                listing={listing}
                onChanged={replace}
                onRemoved={drop}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Nothing left to map is worth saying: an empty form beside a full list
          otherwise reads as something still to be done. */}
      {unmapped.length > 0 || settings.apps.length === 0 ? (
        <AddListing apps={unmapped} onAdded={replace} />
      ) : (
        <p className="footnote">Every app in scope has a listing mapped.</p>
      )}
    </>
  );
}
