# WebSend

Serverless peer-to-peer file and text sharing in the browser. Files go directly between devices over an encrypted WebRTC channel. There is no backend, no account and no upload.

## Use

Open WebSend on both devices. On one, tap **Start a connection**; on the other, **Join a connection**. Both then walk the same three steps:

1. **Invite**: the starting device gives its invite and the joining device gets it.
2. **Reply**: the joining device gives a reply and the starting device gets it.
3. **Share**: you're connected.

Each step lets you pick how the code travels, and you can pick more than one:

- **Giving**: **QR code** (scan it with the other device's camera app), **Link** (copy, share or send it through any app) or **Sound** (the device chirps the code).
- **Getting**: **Camera** (scan the other device's QR code with this device's camera app), **Paste** (a link or code you were sent) or **Listen** (allow the microphone and hear the other device's chirps).

The two steps can use different methods. For example, scan a PC's QR code with your phone, then pick Sound on the phone and Listen on the PC so the phone chirps its reply back. Sound works best with the devices close together and the volume up.

Once connected, check both screens show the same 6-digit number. Either side can then send files, folders or text. The receiver ticks the files they want (all are ticked to start, with **Select all** to toggle) and taps **Download**, **Download as .zip** (keeps folder structure), **Save to folder…** (Chrome/Edge desktop) or **Decline**. Each file also has its own **Save** button. Unticked files stay available, and received ones can be downloaded again the same way.

If the connection drops, connect again in the same tabs. Unfinished transfers resume where they stopped.

## Host

Any static host over HTTPS (GitHub Pages, Cloudflare Pages, Netlify). Upload `index.html`, `app.js`, `sound.js`, `tap.js`, `style.css`, `qrcode.js`, `client-zip.js`. No build step.

## Security

- **Encrypted end to end** by WebRTC (DTLS). The connection code carries the peer's certificate fingerprint, so only the device holding the matching key can connect. Codes swapped in person (QR) can't be intercepted. Codes sent through a messenger are as trustworthy as that messenger.
- **Matching numbers prove a direct connection.** After connecting, both screens show a number derived from both devices' keys. If someone substituted their own code (by answering a sound code first, or tampering with a message), the numbers differ.
- **Sound codes can be heard by anyone nearby.** Overhearing one doesn't let anyone decrypt anything, but someone could reply first. The matching number catches that.
- **Nothing passes through a server.** Codes are in the URL fragment (`#…`), which browsers never send to the web host, and the page clears it from the address bar on load.
- **Receiver must accept** every batch of files. Received names are only ever shown as text.
- **Strict Content-Security-Policy:** only the page's own scripts run, and there are no third-party requests.
- **One third party, optional:** Google's public STUN servers tell each device its public address so devices on different networks can connect. Two are asked so the connection log can spot symmetric NAT. They see IP addresses only, never data. Set `ICE = []` in `app.js` for same-network-only with zero third parties.

## Sound

`sound.js` is a small acoustic modem: 16-tone FSK at 25 ms a symbol (1–5 kHz), tone sets that rotate so room echo doesn't blur neighbouring symbols, two-tone sync chords, and Reed–Solomon error correction. Each device repeats its code, and the listener adds up what it heard across repeats, so a noisy room costs another round instead of failing. A code takes about 6–7 seconds to send.

`node test/sound-sim.js` plays frames through a simulated room (echo, noise, mismatched sample rates and clocks) into the decoder. `test/fake-air-inject.js` wires two browser tabs' speakers to each other's microphones so the whole sound handshake can be tried without hardware.

## Troubleshooting

The **Connection log** at the bottom of the page records each step of connecting: the addresses each device found, STUN errors, connectivity check states and, if it fails, every address pair tried with how many checks were sent and answered, plus a best guess at the cause. It opens by itself on an error. Tap **Copy log** on both devices and compare. It includes IP addresses, so share it only with people you trust.

Common findings: no public address (the network blocks UDP to STUN), a different public port per STUN server (symmetric NAT, common on campus and corporate Wi-Fi), or checks sent but never answered (a firewall drops peer-to-peer traffic). Without a relay these can't connect across networks; a phone hotspot on one side usually works.

## Limits

- Peers behind strict NAT (some mobile carriers and corporate networks) can't connect directly. There's no relay by design. Same Wi-Fi always works.
- Without **Save to folder…**, a received file is held in browser storage until saved, and folder paths are flattened into file names (`dir_sub_file.txt`).
- Resume works while both tabs stay open; it isn't persisted across reloads.
- Connect by sound needs a working speaker and microphone on both devices. Very loud rooms, or a laptop whose microphone filters out tones, may need another method instead.

`qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by Kazuhiko Arase (MIT).
`client-zip.js` is [client-zip](https://github.com/Touffy/client-zip) 2.5.1 by David Junger (MIT), its `worker.js` build.
