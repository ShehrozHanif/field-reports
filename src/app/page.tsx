'use client';

import { useEffect, useState } from 'react';
import ReportForm from '@/components/ReportForm';
import QueueList from '@/components/QueueList';
import ServerCheck from '@/components/ServerCheck';
import { start, subscribe } from '@/lib/outbox';
import type { QueueItem } from '@/lib/sync-core.mjs';

export default function Page() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribe(setItems);
    void start();

    // Lets the app be opened with no network at all. See public/sw.js.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Not fatal: without it the queue still works, the app just cannot be
        // cold-launched offline. Nothing about delivery depends on this.
      });
    }

    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);

    return () => {
      unsubscribe();
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return (
    <main className="wrap">
      <h1>Field Reports</h1>
      <p className="sub">
        Reports are saved on this device first and sent when they can be. Nothing is marked
        confirmed until the server says so.
      </p>

      <div className="net">
        <span className={`dot ${online ? '' : 'off'}`} />
        {online ? 'Device reports a connection' : 'No connection - reports will queue'}
      </div>

      <ReportForm />
      <QueueList items={items} />
      <ServerCheck />
    </main>
  );
}
