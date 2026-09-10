'use client';

import { useEffect, useRef, useState } from 'react';
import { enqueue } from '@/lib/outbox';
import { validate } from '@/lib/sync-core.mjs';

/**
 * Karachi city centre. Used when the browser will not give us a fix - the
 * brief says geolocation APIs are not what is being tested, so we fall back
 * loudly rather than blocking the worker from filing a report.
 */
const FALLBACK = { lat: 24.8607, lng: 67.0011 };

type Fix = { lat: number; lng: number; source: 'device' | 'fallback' | 'manual' };

export default function ReportForm() {
  const [outlet, setOutlet] = useState('');
  const [finding, setFinding] = useState('');
  const [action, setAction] = useState('');
  const [fix, setFix] = useState<Fix>({ ...FALLBACK, source: 'fallback' });
  const [locating, setLocating] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  // Guards a double tap on a slow phone. Two submits a millisecond apart would
  // be two different client_report_ids carrying identical content, and the
  // server fingerprints on content - so they would land as a genuine duplicate.
  const busy = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setFix({ lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), source: 'device' });
        setLocating(false);
      },
      () => setLocating(false),
      { timeout: 8000, maximumAge: 60000 }
    );
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy.current) return;

    const input = {
      outlet_name: outlet,
      finding,
      action_needed: action,
      lat: fix.lat,
      lng: fix.lng,
    };

    const found = validate(input);
    setErrors(found);
    if (Object.keys(found).length) return;

    busy.current = true;
    setSubmitting(true);
    try {
      const item = await enqueue(input);
      setOutlet('');
      setFinding('');
      setAction('');
      setSaved(item.client_report_id);
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit} noValidate>
      <h2>New report</h2>

      <div className="field">
        <label htmlFor="outlet">Outlet name</label>
        <input
          id="outlet"
          value={outlet}
          onChange={(e) => setOutlet(e.target.value)}
          autoComplete="off"
          placeholder="e.g. Al-Madina Store, Korangi"
        />
        {errors.outlet_name && <div className="err">{errors.outlet_name}</div>}
      </div>

      <div className="field">
        <label htmlFor="finding">What you found</label>
        <textarea id="finding" value={finding} onChange={(e) => setFinding(e.target.value)} />
        {errors.finding && <div className="err">{errors.finding}</div>}
      </div>

      <div className="field">
        <label htmlFor="action">Action needed</label>
        <textarea id="action" value={action} onChange={(e) => setAction(e.target.value)} />
        {errors.action_needed && <div className="err">{errors.action_needed}</div>}
      </div>

      <div className="field">
        <label>GPS coordinates</label>
        <div className="row">
          <input
            aria-label="Latitude"
            inputMode="decimal"
            value={fix.lat}
            onChange={(e) => setFix({ ...fix, lat: Number(e.target.value), source: 'manual' })}
          />
          <input
            aria-label="Longitude"
            inputMode="decimal"
            value={fix.lng}
            onChange={(e) => setFix({ ...fix, lng: Number(e.target.value), source: 'manual' })}
          />
        </div>
        {(errors.lat || errors.lng) && <div className="err">{errors.lat || errors.lng}</div>}
        <div className="note">
          {locating
            ? 'Asking the device for a fix...'
            : fix.source === 'device'
              ? 'Using the device fix.'
              : fix.source === 'manual'
                ? 'Entered by hand.'
                : 'No device fix - falling back to Karachi city centre (24.8607, 67.0011). Editable above.'}
        </div>
      </div>

      <button type="submit" disabled={submitting}>
        {submitting ? 'Saving...' : 'Submit report'}
      </button>

      {saved && (
        <div className="note" style={{ marginTop: 12 }}>
          Saved on this device and queued. It has <strong>not</strong> been sent yet - watch the
          queue below for the server&apos;s confirmation.
        </div>
      )}

    </form>
  );
}
