// ---------- Connection log ----------
// Shown on the page (not just the console) so a failed connection can be diagnosed and the log copied from any device.
// level: '' | 'warn' | 'err'. Errors open the log.
import { ICE } from './config.js';
import { $, el, why } from './util.js';
import { pc } from './peer.js';

const T0 = performance.now(), tally = { warn: 0, err: 0 };
export function log(msg, level = '') {
  $('diagLog').append(el('li', { className: level, textContent: `+${((performance.now() - T0) / 1000).toFixed(1)}s ${level ? level.toUpperCase() + ' ' : ''}${msg}` }));
  if (!level) return;
  tally[level]++;
  $('diagCount').textContent = `(${[tally.err && tally.err + ' error' + (tally.err > 1 ? 's' : ''), tally.warn && tally.warn + ' warning' + (tally.warn > 1 ? 's' : '')].filter(Boolean).join(', ')})`;
  if (level === 'err') $('diag').open = true;
}
addEventListener('error', e => log('Script error: ' + e.message, 'err'));
addEventListener('unhandledrejection', e => log('Unhandled error: ' + why(e.reason), 'err'));
$('diagCopy').onclick = async e => {
  const text = [...$('diagLog').children].map(li => li.textContent).join('\n');
  try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch (err) { log("Couldn't copy the log: " + why(err), 'warn'); }
  setTimeout(() => e.target.textContent = 'Copy log', 1500);
};
log(`Opened ${new Date().toISOString()} in ${navigator.userAgent}`);
log('STUN servers: ' + (ICE.flatMap(s => s.urls).join(', ') || 'none'));

const addresses = code => code.slice(1).split(',').slice(3).map(c => ({ pub: c[0] === 's', ip: c.slice(1, c.lastIndexOf('_')), port: c.slice(c.lastIndexOf('_') + 1) }));

// What usually stops two networks connecting, read from the addresses in a code, as [problem, address]:
//   none: no addresses, so nothing can connect to it
//   local: no public address (no STUN reply), so only a device on the same network can
//   symmetric: a different public port per STUN server (symmetric NAT), so other networks usually can't without a relay
//   warp: it comes through Cloudflare WARP, whose NAT drops peer-to-peer UDP from outside
export function problems(code) {
  const addrs = addresses(code), found = [];
  if (!addrs.length) return [['none']];
  if (!addrs.some(a => a.pub)) found.push(['local']);
  const ports = new Map();
  for (const a of addrs) if (a.pub) ports.set(a.ip, (ports.get(a.ip) || new Set()).add(a.port));
  if ([...ports.values()].some(s => s.size > 1)) found.push(['symmetric']);
  const warp = addrs.find(a => a.pub && (/^104\.28\./.test(a.ip) || /^2a09:bac[0-7]:/i.test(a.ip))); // WARP's egress ranges
  if (warp) found.push(['warp', warp.ip]);
  return found;
}

const FLAG = {
  none: l => [`${l} has no addresses, so nothing can connect to it.`, 'err'],
  local: l => [`${l} has no public address (no STUN reply, so the network may block UDP; or the devices found each other first), so only a device on the same network can reach it.`, 'warn'],
  symmetric: l => [`${l}'s network gave a different public port to each STUN server (symmetric NAT, or several network adapters). Devices on other networks usually can't reach it without a relay.`, 'warn'],
  warp: (l, ip) => [`${l} comes through Cloudflare WARP (${ip}), which blocks connections from other networks. Turn WARP off on that device and connect again.`, 'warn'],
};

// Lists the addresses in a code and flags what usually stops two networks connecting.
export function logCode(label, code) {
  const addrs = addresses(code);
  log(`${label}: ${addrs.length} address${addrs.length === 1 ? '' : 'es'}` + addrs.map(a => `\n    ${a.pub ? 'public' : 'local '} ${a.ip}:${a.port}`).join(''));
  for (const [p, ip] of problems(code)) if (p !== 'local' || pc?.iceConnectionState !== 'connected') log(...FLAG[p](label, ip));
}

// Address pairs and how far their checks got. Chrome drops failed pairs from its stats, so they're sampled while connecting.
export const pairs = new Map();
export async function samplePairs(p) {
  const s = await p.getStats();
  const c = id => { const x = s.get(id); return x ? `${x.candidateType} ${x.protocol} ${x.address || x.ip || '(hidden)'}:${x.port}` : '?'; };
  if (p === pc) s.forEach(r => r.type === 'candidate-pair' && pairs.set(r.id, { ...r, local: c(r.localCandidateId), remote: c(r.remoteCandidateId) }));
}

// After a failed attempt: every address pair tried and how far its checks got, then a best guess at why.
export async function report(p) {
  try { await samplePairs(p); } catch (e) { log("Couldn't read connection stats: " + why(e), 'warn'); }
  let answered = 0, received = 0;
  for (const r of pairs.values()) {
    answered += r.responsesReceived || 0;
    received += r.requestsReceived || 0;
    log(`Pair ${r.local} → ${r.remote}: ${r.state}, checks sent ${r.requestsSent ?? '?'}, answered ${r.responsesReceived ?? '?'}, received ${r.requestsReceived ?? '?'}`);
  }
  log(!pairs.size ? 'No address pairs were tried: one side gave no usable addresses.'
    : answered ? 'Some checks were answered, yet the connection still failed (the encryption handshake failed, or traffic was blocked after the first packets).'
    : received ? "The other device's checks reached this one, but none of this device's checks were answered: their network or NAT drops incoming traffic."
    : 'No checks got through in either direction: a firewall blocks peer-to-peer UDP, or both sides are behind strict NAT. Try a phone hotspot on one side.', 'err');
}
