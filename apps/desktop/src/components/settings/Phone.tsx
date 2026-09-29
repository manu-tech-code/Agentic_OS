import { useEffect, useMemo, useState } from 'react';
import type { ClientEvent } from '@nova/core/protocol';
import { qrCode, qrPath } from '@nova/core/qr';
import { personalize, type SettingsSnapshot } from '@nova/core/settings';

/** Now, every second: for a countdown. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const day = (at: number) => new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : day(at);
};

/** The pairing code: black on white whatever the theme, so any camera reads it. */
function PairingCode({ link }: { link: string }) {
  const code = useMemo(() => qrCode(link, 'M'), [link]);
  const side = code.size + 8;
  return (
    <svg className="pairing__qr" viewBox={`0 0 ${side} ${side}`} role="img" aria-label="Pairing code for the iPhone" shapeRendering="crispEdges">
      <rect width={side} height={side} fill="#fff" />
      <path d={qrPath(code)} fill="#000" />
    </svg>
  );
}

/** Settings → iPhone: the door for paired phones, pairing one, and the phones paired. */
export function PhonePanel({ snapshot, name, onAction }: { snapshot: SettingsSnapshot; name: string; onAction: (event: ClientEvent) => void }) {
  const { phone } = snapshot;
  const enabled = snapshot.values['phone.enabled'] === true;
  const now = useNow(Boolean(phone.pairing) || phone.devices.length > 0);
  const [copied, setCopied] = useState(false);
  const left = phone.pairing ? Math.max(0, Math.ceil((phone.pairing.expires - now) / 1000)) : 0;
  const copy = (link: string) =>
    void navigator.clipboard?.writeText(link).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 1500)),
      () => {},
    );

  return (
    <>
      <div className="tile">
        <div className="tile__head">
          <span className={`dot ${phone.door ? 'dot--on' : ''}`} />
          <strong>{phone.door ? 'Open for your paired iPhones' : enabled ? 'Opening…' : "iPhones can't connect"}</strong>
          {phone.door && (
            <span className="muted">
              on {phone.door.addresses.join(', ') || 'no network'} · port {phone.door.port}
            </span>
          )}
          {phone.door && !phone.pairing && (
            <span className="tile__actions">
              <button type="button" className="btn btn--primary" onClick={() => onAction({ type: 'phone-pair', action: 'start' })}>
                Pair an iPhone
              </button>
            </span>
          )}
        </div>
        {!enabled && (
          <span className="muted">
            {personalize('Turn on "Let your iPhone connect" below, then pair your iPhone here. Nova on the iPhone is built from apps/ios on this Mac (npm run phone).', name)}
          </span>
        )}
        {phone.message && <div className="banner banner--error">{phone.message}</div>}
      </div>

      {phone.pairing && (
        <div className="tile pairing">
          <PairingCode link={phone.pairing.link} />
          <div className="pairing__text">
            <strong>{personalize('Scan this with Nova on your iPhone', name)}</strong>
            <span className="muted">
              {personalize(
                'Open Nova on the iPhone and tap Pair. The code works once, for one phone, on this Wi-Fi - the phone then checks it is really this Mac every time it connects.',
                name,
              )}
            </span>
            <span className="muted">
              Works for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.
            </span>
            <span className="tile__actions">
              <button type="button" className="btn btn--ghost" onClick={() => copy(phone.pairing!.link)} title="For the iOS Simulator, or to AirDrop to the phone">
                {copied ? 'Copied' : 'Copy the link'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => onAction({ type: 'phone-pair', action: 'stop' })}>
                Cancel
              </button>
            </span>
          </div>
        </div>
      )}

      {phone.devices.length > 0 && (
        <div className="tile">
          <div className="tile__head">
            <strong>Paired</strong>
            <span className="muted">each proves who it is with a key only it holds</span>
          </div>
          {phone.devices.map((d) => (
            <div key={d.id} className="tile__head">
              <span className={`dot ${d.connected ? 'dot--on' : ''}`} />
              <strong>{d.name}</strong>
              <span className="muted">
                {[d.model, `paired ${day(d.pairedAt)}`, d.connected ? 'connected now' : d.lastSeen ? `last here ${ago(d.lastSeen, now)}` : null].filter(Boolean).join(' · ')}
              </span>
              <span className="tile__actions">
                <button type="button" className="btn btn--ghost" onClick={() => onAction({ type: 'phone-forget', id: d.id })}>
                  Forget
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
