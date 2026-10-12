# WebSend

Serverless peer-to-peer file and text sharing in the browser. Files go directly between devices over an encrypted WebRTC channel. There is no backend, no account and no upload.

## Use

1. Device A: add files (optional, they can be added later), tap **Create connection code**.
2. Device B: scan the QR with the camera, or open the link. B shows a **reply code**.
3. Device A: scan B's reply QR with the camera, or paste the reply link. You're connected.
4. Check both screens show the same 6-digit number.
5. Either side can send files, folders or text. The receiver taps **Download**, **Save to folder…** (Chrome/Edge desktop) or **Decline**.

**By sound:** in the same room, tap **Connect by sound** on both devices, then **Create connection code** on one. The codes are exchanged as tones (about 5 seconds each way). Allow the microphone when asked.

If the connection drops, make a new code in the same tabs. Unfinished transfers resume where they stopped.

## Host

Any static host over HTTPS (GitHub Pages, Cloudflare Pages, Netlify). Upload `index.html`, `app.js`, `tap.js`, `style.css`, `qrcode.js`. No build step.

## Security

- **Encrypted end to end** by WebRTC (DTLS). The connection code carries the peer's certificate fingerprint, so only the device holding the matching key can connect. Codes swapped in person (QR) can't be intercepted. Codes sent through a messenger are as trustworthy as that messenger.
- **Matching numbers prove a direct connection.** After connecting, both screens show a number derived from both devices' keys. If someone substituted their own code (by answering a sound code first, or tampering with a message), the numbers differ.
- **Sound codes can be heard by anyone nearby.** Overhearing one doesn't let anyone decrypt anything, but someone could reply first. The matching number catches that.
- **Nothing passes through a server.** Codes are in the URL fragment (`#…`), which browsers never send to the web host, and the page clears it from the address bar on load.
- **Receiver must accept** every batch of files. Received names are only ever shown as text.
- **Strict Content-Security-Policy:** only the page's own scripts run, and there are no third-party requests.
- **One third party, optional:** Google's public STUN server tells each device its public address so devices on different networks can connect. It sees IP addresses only, never data. Set `ICE = []` in `app.js` for same-network-only with zero third parties.

## Limits

- Peers behind strict NAT (some mobile carriers and corporate networks) can't connect directly. There's no relay by design. Same Wi-Fi always works.
- Without **Save to folder…**, a received file is held in browser storage until saved, and folder paths are flattened into file names (`dir_sub_file.txt`).
- Resume works while both tabs stay open; it isn't persisted across reloads.

`qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by Kazuhiko Arase (MIT).
