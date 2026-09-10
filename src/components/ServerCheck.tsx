'use client';

import { useState } from 'react';
import { debugCount } from '@/lib/api';

/**
 * Reads the same endpoint the assessment reads, so the verdict can be seen
 * without leaving the app. Purely a development aid.
 */
export default function ServerCheck() {
  const [out, setOut] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function check() {
    setLoading(true);
    const res = await debugCount();
    setOut(
      res.status === 200
        ? JSON.stringify(res.body, null, 2)
        : `Could not reach the mock server (status ${res.status}). Is "npm run mock" running?`
    );
    setLoading(false);
  }

  return (
    <section className="card">
      <h2>Server check</h2>
      <div className="actions">
        <button className="ghost" onClick={() => void check()} disabled={loading}>
          {loading ? 'Checking...' : 'GET /v1/_debug/count'}
        </button>
      </div>
      {out && <pre>{out}</pre>}
    </section>
  );
}
