// ---------- Connection code <-> SDP ----------
// Code: <kind><ufrag>,<pwd>,<fingerprint b64>,<candidates...>
// kind: o = offer; a / p = answer taking DTLS role active / passive. Candidate: h|s (host|srflx) + ip + "_" + port.
import { b64, unb64 } from './util.js';

export function encode({ type, sdp }) {
  const get = k => sdp.match(new RegExp(`a=${k}:(.+)`))[1].trim();
  const [alg, hex] = get('fingerprint').split(' ');
  if (alg.toLowerCase() !== 'sha-256') throw new Error('unsupported fingerprint');
  const cands = new Set([...sdp.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ (host|srflx)/gi)].map(m => m[3][0] + m[1] + '_' + m[2]));
  const kind = type === 'offer' ? 'o' : get('setup') === 'passive' ? 'p' : 'a';
  return kind + [get('ice-ufrag'), get('ice-pwd'), b64(hex.split(':').map(h => parseInt(h, 16))), ...cands].join(',');
}

export function decode(code, mid = '0') {
  const [ufrag, pwd, fp, ...cands] = code.slice(1).split(',');
  const fingerprint = [...unb64(fp)].map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
  if (!/^[oap]$/.test(code[0]) || !/^[\w+/]+$/.test(ufrag + pwd) || fingerprint.length !== 95 ||
      !cands.every(c => /^[hs][\w.:-]+_\d+$/.test(c))) throw new Error('bad code');
  const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', `a=group:BUNDLE ${mid}`,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${{ o: 'actpass', a: 'active', p: 'passive' }[code[0]]}`, `a=mid:${mid}`,
    'a=sctp-port:5000', 'a=max-message-size:262144',
    ...cands.map((c, i) => {
      const [ip, port] = c.slice(1).split('_'), host = c[0] === 'h';
      return `a=candidate:${i} 1 udp ${host ? 2113937151 : 1677729535} ${ip} ${port} typ ${host ? 'host' : 'srflx raddr 0.0.0.0 rport 0'}`;
    }), 'a=end-of-candidates', ''].join('\r\n');
  return { type: code[0] === 'o' ? 'offer' : 'answer', sdp };
}
