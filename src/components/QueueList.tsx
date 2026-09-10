'use client';

import { useEffect, useState } from 'react';
import type { QueueItem } from '@/lib/sync-core.mjs';
import { clearSettled, retryNow } from '@/lib/outbox';

/**
 * The queue, told honestly.
 *
 * The rule here is that nothing says "Sent" until the server has handed back a
 * report_id - either a 201 or a 409. Everything before that says, in plain
 * words, that the report is on the phone and not yet confirmed. Not "not sent":
 * after a save-then-drop the server already has it, we just have not heard. A worker
 * who is told a report went through when it did not is worse off than one who
 * is told nothing at all.
 */

const LABEL: Record<QueueItem['status'], string> = {
  queued: 'Waiting',
  sending: 'Sending',
  sent: 'Confirmed',
  rejected: 'Rejected',
};

function countdown(item: QueueItem, now: number, online: boolean): string {
  if (item.status !== 'queued') return '';
  // The outbox does not send while the device reports no network, so a
  // countdown here would promise a retry that is not going to happen.
  if (!online) return 'waiting for a connection';
  const secs = Math.ceil((item.next_attempt_at - now) / 1000);
  if (secs <= 0) return 'retrying now';
  return `retrying in ${secs}s`;
}

export default function QueueList({ items, online }: { items: QueueItem[]; online: boolean }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const pending = items.filter((i) => i.status === 'queued' || i.status === 'sending').length;
  const settled = items.filter((i) => i.status === 'sent' || i.status === 'rejected').length;

  return (
    <section className="card">
      <h2>Queue on this device</h2>

      {items.length === 0 && (
        <p className="empty">Nothing queued. Reports you submit will be listed here.</p>
      )}

      {items.map((item) => (
        <article key={item.client_report_id} className="item">
          <div className="top">
            <span className="name">{item.payload.outlet_name}</span>
            <span className={`pill ${item.status}`}>{LABEL[item.status]}</span>
          </div>

          <div className="body">{item.payload.finding}</div>

          <div className="meta">
            {item.status === 'sent' && (
              <>
                server id {item.server_report_id ?? '(none returned)'}
                {item.deduped && ' - server already had this one, so it was not stored twice'}
              </>
            )}

            {item.status === 'queued' && (
              <>
                saved on this device, not confirmed by the server yet
                {' - '}
                {countdown(item, now, online)}
                {item.attempts > 0 && ` - ${item.attempts} attempt${item.attempts === 1 ? '' : 's'} so far`}
                {item.last_error && ` - last: ${item.last_error}`}
              </>
            )}

            {item.status === 'sending' && <>attempt {item.attempts + 1} in flight...</>}

            {item.status === 'rejected' && (
              <>the server refused this report and will keep refusing it - {item.last_error}</>
            )}
          </div>

          <div className="meta">id {item.client_report_id}</div>

          {item.status === 'rejected' && (
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="ghost" onClick={() => void retryNow(item.client_report_id)}>
                Try again anyway
              </button>
            </div>
          )}
        </article>
      ))}

      {items.length > 0 && (
        <div className="actions" style={{ marginTop: 12 }}>
          <span className="empty" style={{ flex: 1, fontStyle: 'normal' }}>
            {pending} waiting to send, {settled} finished
          </span>
          {settled > 0 && (
            <button className="ghost" onClick={() => void clearSettled()}>
              Clear finished
            </button>
          )}
        </div>
      )}
    </section>
  );
}
