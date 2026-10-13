# WebSend

Serverless peer-to-peer file and text sharing in the browser. Files go directly between devices over an encrypted WebRTC channel. There is no backend, no account and no upload.

## Use

Open WebSend on both devices and pick how to connect:

- **Connect by sound** (same room): tap it on both devices and allow the microphone. They chirp their codes to each other and connect by themselves, usually within 15–30 seconds. Keep them close with the volume up.
- **Show a QR code**: scan it with the other device's camera app (or send it the link). That device then shows a reply code: scan it back, or paste the reply link into the first device.
- **I have a code**: paste a link or code you were sent.

Methods can be mixed: on any code screen, **Also use sound** plays that device's code and listens for the other's. For example, scan a PC's QR code with your phone, then turn on sound on both and the phone chirps its reply to the PC.

Once connected, check both screens show the same 6-digit number. Either side can then send files, folders or text. The receiver taps **Download**, **Save to folder…** (Chrome/Edge desktop) or **Decline**.

If the connection drops, connect again in the same tabs. Unfinished transfers resume where they stopped.

## Host

Any static host over HTTPS (GitHub Pages, Cloudflare Pages, Netlify). Upload `index.html`, `app.js`, `sound.js`, `tap.js`, `style.css`, `qrcode.js`. No build step.

## Security

- **Encrypted end to end** by WebRTC (DTLS). The connection code carries the peer's certificate fingerprint, so only the device holding the matching key can connect. Codes swapped in person (QR) can't be intercepted. Codes sent through a messenger are as trustworthy as that messenger.
- **Matching numbers prove a direct connection.** After connecting, both screens show a number derived from both devices' keys. If someone substituted their own code (by answering a sound code first, or tampering with a message), the numbers differ.
- **Sound codes can be heard by anyone nearby.** Overhearing one doesn't let anyone decrypt anything, but someone could reply first. The matching number catches that.
- **Nothing passes through a server.** Codes are in the URL fragment (`#…`), which browsers never send to the web host, and the page clears it from the address bar on load.
- **Receiver must accept** every batch of files. Received names are only ever shown as text.
- **Strict Content-Security-Policy:** only the page's own scripts run, and there are no third-party requests.
- **One third party, optional:** Google's public STUN server tells each device its public address so devices on different networks can connect. It sees IP addresses only, never data. Set `ICE = []` in `app.js` for same-network-only with zero third parties.

## Sound

`sound.js` is a small acoustic modem: 16-tone FSK at 25 ms a symbol (1–5 kHz), tone sets that rotate so room echo doesn't blur neighbouring symbols, two-tone sync chords, and Reed–Solomon error correction. Each device repeats its code, and the listener adds up what it heard across repeats, so a noisy room costs another round instead of failing. A code takes about 6–7 seconds to send.

`node test/sound-sim.js` plays frames through a simulated room (echo, noise, mismatched sample rates and clocks) into the decoder. `test/fake-air-inject.js` wires two browser tabs' speakers to each other's microphones so the whole sound handshake can be tried without hardware.

## Limits

- Peers behind strict NAT (some mobile carriers and corporate networks) can't connect directly. There's no relay by design. Same Wi-Fi always works.
- Without **Save to folder…**, a received file is held in browser storage until saved, and folder paths are flattened into file names (`dir_sub_file.txt`).
- Resume works while both tabs stay open; it isn't persisted across reloads.
- Connect by sound needs a working speaker and microphone on both devices. Very loud rooms, or a laptop whose microphone filters out tones, may need the QR code instead.

`qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by Kazuhiko Arase (MIT).
