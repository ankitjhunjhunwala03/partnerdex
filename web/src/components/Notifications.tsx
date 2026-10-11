import { useCallback, useEffect, useState } from 'react';
import {
  createChannel,
  deleteChannel,
  fetchNotifications,
  setChannelTopic,
  testChannel,
  type NotificationChannel,
  type NotificationSettings,
  type NotificationTopic,
} from '../api';
import { formatDateTime } from '../format';
import { InfoTip } from './InfoTip';

/**
 * Where events go, and which ones.
 *
 * Two facts shape this page. A webhook URL is a credential the server will not
 * read back, so the field is write-only and a saved channel is identified by a
 * masked hint. And a toggle takes effect from the moment it is switched on —
 * never retroactively — which is stated on the page rather than left to be
 * discovered by a channel that stays silent after a first sync.
 */

const WEBHOOK_PLACEHOLDER = 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX';

function ChannelRow({
  channel,
  topics,
  onChanged,
  onRemoved,
}: {
  channel: NotificationChannel;
  topics: NotificationTopic[];
  onChanged: (next: NotificationChannel) => void;
  onRemoved: (id: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const toggle = async (topic: NotificationTopic, enabled: boolean) => {
    setBusy(topic.key);
    setError(null);
    setTested(null);
    try {
      onChanged(await setChannelTopic(channel.id, topic.key, enabled));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setError(null);
    setTested(null);
    try {
      const result = await testChannel(channel.id);
      onChanged(result.channel);
      if (result.ok) setTested('Test message delivered.');
      else setError(result.error ?? 'The webhook did not accept the message.');
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
      await deleteChannel(channel.id);
      onRemoved(channel.id);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="channel">
      <div className="channel-head">
        <div>
          <h3 className="channel-name">{channel.name}</h3>
          <p className="channel-hint">
            {channel.webhookHint}
            <InfoTip label="Webhook">
              The Slack webhook this channel posts to, masked to its last four characters. The full
              URL is stored on the server and never shown again; remove and re-add the channel to
              change it.
            </InfoTip>
          </p>
        </div>

        <div className="channel-actions">
          <button type="button" onClick={test} disabled={busy !== null}>
            {busy === 'test' ? 'Sending…' : 'Send a test'}
          </button>
          {confirmingRemove ? (
            <>
              <button
                type="button"
                className="danger"
                onClick={remove}
                disabled={busy !== null}
              >
                {busy === 'remove' ? 'Removing…' : 'Confirm remove'}
              </button>
              <button type="button" onClick={() => setConfirmingRemove(false)} disabled={busy !== null}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmingRemove(true)} disabled={busy !== null}>
              Remove
            </button>
          )}
        </div>
      </div>

      <ul className="topic-list">
        {topics.map((topic) => {
          const enabled = channel.topics.includes(topic.key);
          return (
            <li className="topic" key={topic.key}>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy !== null}
                  onChange={(event) => toggle(topic, event.target.checked)}
                />
                <span className="switch-track" aria-hidden="true" />
                <span className="switch-text">
                  <span className="topic-label">
                    {topic.label}
                    <InfoTip label={topic.label}>
                      When on, each new event listed below posts a message to this channel after
                      the sync that finds it. Events from before you switched it on are never sent.
                    </InfoTip>
                  </span>
                  <span className="topic-description">{topic.description}</span>
                </span>
              </label>

              <ul className="topic-covers">
                {topic.covers.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>

      {error ? <p className="channel-status bad">{error}</p> : null}
      {tested ? <p className="channel-status good">{tested}</p> : null}

      {!error && !tested && channel.lastError ? (
        <p className="channel-status bad">
          Last attempt failed: {channel.lastError}
          {channel.lastErrorAt ? ` (${formatDateTime(channel.lastErrorAt)})` : ''}
        </p>
      ) : null}

      {!error && !tested && !channel.lastError && channel.lastDeliveryAt ? (
        <p className="channel-status">
          Last delivered {formatDateTime(channel.lastDeliveryAt)}.
        </p>
      ) : null}
    </div>
  );
}

function AddChannel({ onAdded }: { onAdded: (channel: NotificationChannel) => void }) {
  const [name, setName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onAdded(await createChannel({ name: name.trim(), webhookUrl: webhookUrl.trim() }));
      setName('');
      setWebhookUrl('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card full channel-form" onSubmit={submit}>
      <h2 className="card-label">Add a channel</h2>
      <p className="card-subtitle">
        In Slack, create an <strong>Incoming Webhook</strong> for the channel you want events in,
        then paste its URL here. The URL is stored locally and never shown again.
      </p>

      <div className="field-row">
        <div className="control">
          <label htmlFor="channel-name">
            Name
            <InfoTip label="Name">
              A label for this channel on this page, such as the Slack channel it posts to. It does
              not change where messages go.
            </InfoTip>
          </label>
          <input
            id="channel-name"
            type="text"
            placeholder="#revenue"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            required
          />
        </div>

        <div className="control control-grow">
          <label htmlFor="channel-url">
            Slack webhook URL
            <InfoTip label="Slack webhook URL">
              The Incoming Webhook address Slack gives you for one channel. Messages for the events
              you switch on are posted there.
            </InfoTip>
          </label>
          <input
            id="channel-url"
            type="url"
            placeholder={WEBHOOK_PLACEHOLDER}
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>

        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Adding…' : 'Add channel'}
        </button>
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}
    </form>
  );
}

export function Notifications() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchNotifications()
      .then((result) => {
        if (!cancelled) setSettings(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const replace = useCallback((next: NotificationChannel) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            channels: current.channels.map((channel) =>
              channel.id === next.id ? next : channel,
            ),
          }
        : current,
    );
  }, []);

  const append = useCallback((next: NotificationChannel) => {
    setSettings((current) =>
      current ? { ...current, channels: [...current.channels, next] } : current,
    );
  }, []);

  const drop = useCallback((id: string) => {
    setSettings((current) =>
      current
        ? { ...current, channels: current.channels.filter((channel) => channel.id !== id) }
        : current,
    );
  }, []);

  if (loading) return <div className="skeleton">Loading notification settings…</div>;

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load notification settings</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <>
      <AddChannel onAdded={append} />

      {settings.channels.length === 0 ? (
        <div className="notice">
          <h2>No channels yet</h2>
          <p>
            Add a Slack webhook above, then switch on the events you want. Notifications are sent
            after each sync, so they arrive within a few minutes of the merchant action.
          </p>
        </div>
      ) : (
        <div className="channel-list">
          {settings.channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              topics={settings.topics}
              onChanged={replace}
              onRemoved={drop}
            />
          ))}
        </div>
      )}

      {settings.channels.length > 0 ? (
        <p className="footnote">
          {/* The one thing about this page that would otherwise be learned by
              being surprised: switching a toggle on does not send the past. */}
          A toggle takes effect from the moment you switch it on — history is never replayed, and
          each event is sent at most once per channel.
        </p>
      ) : null}
    </>
  );
}
