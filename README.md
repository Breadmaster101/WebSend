# WebSend

Serverless peer-to-peer file and text sharing in the browser. Files go directly between devices over an encrypted WebRTC channel. There is no backend, no account and no upload.

## Use

Open WebSend on both devices. On one, tap **Start a connection**; on the other, **Join a connection**. The two devices then swap two codes:

1. **Invite**: the starting device picks how to send its invite, and the joining device picks the same method to take it in.
2. **Reply**: the joining device picks how to send its reply. On the starting device, tap **Next: get its reply** and pick the same method to take it in.

Each time, the choice is one of:

- **QR code**: one device shows a code and the other scans it in the page (the phone's camera app works too).
- **Link**: copy, share or send the link through any app, then paste it on the other device or just open it there.
- **Sound**: one device chirps the code and the other listens. Nothing plays until you tap **Play sound**, and it repeats until you tap **Stop sound**. Chirping only needs a speaker; listening needs the microphone.

The invite and the reply can use different methods. For example, send a PC's invite to your phone as a link, then let the phone chirp its reply back. Sound works best with the devices close together and the volume up.

Once connected, check both screens show the same 6-digit number and tap **Yes, it matches**. Either side can then send files, folders or text, by picking them, dropping them on the page or pasting them (a pasted screenshot is sent as an image; pasted text goes into the text box to check before sending). The receiver ticks the files they want (all are ticked to start, with **Select all** to toggle) and taps **Download**, **Download as .zip** (keeps folder structure), **Save to folder…** (Chrome/Edge desktop) or **Decline**. Each file also has its own **Save** button. Unticked files stay available, and received ones can be downloaded again the same way. While a file is on its way, either side can **Pause**, **Resume** or **Cancel** it. Each file shows its speed and time left, and the top of the page (and the tab's title) shows how far the whole batch has got.

If the connection drops, connect again. Unfinished transfers resume where they stopped, even after a reload on the sending device (add the files again) or a crash on the receiving one. Reloading or closing the receiving tab deletes its unfinished downloads, so those start over.

## Host

Any static host over HTTPS (GitHub Pages, Cloudflare Pages, Netlify). Upload `index.html`, the `app/` folder, `sound.js`, `tap.js`, `store.js`, `style.css`, `qrcode.js`, `jsQR.js`, `client-zip.js`, `idb-keyval.js`, plus `LICENSE` and `THIRD-PARTY-NOTICES` so the license texts travel with the code. No build step.

## Security

- **Encrypted end to end** by WebRTC (DTLS). The connection code carries the peer's certificate fingerprint, so only the device holding the matching key can connect. Codes swapped in person (QR) can't be intercepted. Codes sent through a messenger are as trustworthy as that messenger.
- **Matching numbers prove a direct connection.** After connecting, both screens show a number derived from both devices' keys. If someone substituted their own code (by answering a sound code first, or tampering with a message), the numbers differ. Each device also mixes a random value into the number, sending a hash of it before either value is revealed, so a forger can't try key after key until the numbers happen to agree. A guess has a 1 in a million chance. Nothing is offered, sent or accepted until both people have confirmed, including transfers resuming after a reconnect.
- **Extra connections are as safe as the first.** After the check, the devices open two more connections for speed (see [Speed](#speed)). Their codes, with their key fingerprints, travel over the checked connection, never through a server.
- **Sound codes can be heard by anyone nearby.** Overhearing one doesn't let anyone decrypt anything, but someone could reply first. The matching number catches that.
- **Nothing passes through a server.** Codes are in the URL fragment (`#…`), which browsers never send to the web host, and the page clears it from the address bar on load.
- **Camera and microphone stay on the device.** The camera runs only while scanning and the microphone only while listening. Frames and audio are decoded in the page and never sent anywhere.
- **Receiver must accept** every batch of files. Received names are only ever shown as text.
- **Every 4 MB is checked.** The sender sends the SHA-256 of each segment after its bytes, and the receiver stores a segment only once it matches; a damaged one is sent again.
- **Strict Content-Security-Policy:** only the page's own scripts run, and there are no third-party requests.
- **One third party, optional:** Google's public STUN servers tell each device its public address so devices on different networks can connect. Two are asked so the connection log can spot symmetric NAT. They see IP addresses only, never data. The joining device also asks them as soon as you tap **Join a connection**, to check its network, and each lane asks them again. Set `ICE = []` in `app/config.js` for same-network-only with zero third parties.

## Sound

`sound.js` is a small acoustic modem: 16-tone FSK at 25 ms a symbol (1–5 kHz), tone sets that rotate so room echo doesn't blur neighbouring symbols, two-tone sync chords, and Reed–Solomon error correction. Each device repeats its code, and the listener adds up what it heard across repeats, so a noisy room costs another round instead of failing. A code takes about 6–7 seconds to send.

## Storage

Received files are written to the browser's private storage (the origin private file system) as they arrive, so a big file never has to fit in memory. `store.js` does the writing in a worker, and a small IndexedDB note records how much of each download is stored, which is what lets a download resume after a crash. Before accepting, the receiver checks the browser has room; if not, it says so (and suggests **Save to folder…** where available).

A website can't run while it's closed, so WebSend keeps that storage short-lived instead:

- A cancelled, declined or failed file is deleted at once, and **Disconnect** deletes everything the tab stored.
- Closing or reloading the tab deletes everything it stored, finished or not. The browser may stop that partway, so the tab also leaves a note that it closed normally, and the next visit deletes the rest instead of resuming it.
- Each visit deletes whatever no open WebSend tab is using, except unfinished downloads less than a day old, which come back to resume. These are only left behind when a tab crashes or the browser discards it in the background (common on phones), since a normal close deletes them.
- WebSend never asks for persistent storage, so the browser can also clear it on its own when the disk runs low. Safari clears it after seven days without a visit.

So a normal close leaves nothing on disk, except whatever the browser cut short, which the next visit deletes. Only a crashed or discarded tab leaves an unfinished download to resume, and only until the next visit (or until the browser needs the space). Clearing the site's data in the browser removes it too. Browsers without this storage (such as Firefox in a private window) keep received files in memory, as before.

## Speed

A single WebRTC connection slows right down whenever a packet is lost, so over Wi-Fi or the internet it uses only part of the link. WebSend sends over three connections side by side ("lanes"): files are cut into 4 MB segments and each lane takes the next one when it's free, so one big file uses all three and small files go out together. Messages are 256 KB when both browsers take them (64 KB otherwise). If a lane drops, the receiver says what it already has and the rest goes over the others.

Measured between two Chrome instances on one PC, sending 64–128 MB, old vs new:

| Link | One connection, 64 KB | Three lanes, 256 KB |
| --- | --- | --- |
| No delay or loss (CPU-bound) | ~24 MB/s | ~26 MB/s |
| 120 Mbit/s, 6 ms round trip, 0.1% loss (Wi-Fi-like) | ~7 MB/s | ~12 MB/s |

## Troubleshooting

Before any code is swapped, each device checks what its network says about connecting from elsewhere: the starting device from its invite, and the joining device when you tap **Join a connection**. The joining device also reads the starting device's network from the invite. If a device has no public address, its network gives each connection a different public port (symmetric NAT), or it comes through Cloudflare WARP, the connection screens say so and suggest putting both devices on the same Wi-Fi. It's a warning, not a block: two devices on the same network still connect.

The **Connection log** at the bottom of the page records each step of connecting: the addresses each device found, STUN errors, connectivity check states and, if it fails, every address pair tried with how many checks were sent and answered, plus a best guess at the cause. It opens by itself on an error. Tap **Copy log** on both devices and compare. It includes IP addresses, so share it only with people you trust.

Common findings: no public address (the network blocks UDP to STUN), a different public port per STUN server (symmetric NAT, common on campus and corporate Wi-Fi), or checks sent but never answered (a firewall drops peer-to-peer traffic). Without a relay these can't connect across networks; a phone hotspot on one side usually works.

## Limits

- Peers behind strict NAT (some mobile carriers and corporate networks) can't connect directly. There's no relay by design. Same Wi-Fi always works.
- VPNs such as Cloudflare WARP block connections from other networks. Turn the VPN off on that device before connecting; the connection log flags WARP addresses.
- Without **Save to folder…**, folder paths are flattened into file names (`dir_sub_file.txt`) unless you use **Download as .zip**.
- After a reload, the sending device has to add unfinished files again (browsers don't let a page reopen a file by itself). A file is matched by its path, size and modified time. An unfinished download resumes only after its tab crashed or was discarded, for up to a day; reloading or closing it deletes the download.
- Both devices need the same version of WebSend. If one has an old copy open, reload it.
- Connect by sound needs a working speaker and microphone on both devices. Very loud rooms, or a laptop whose microphone filters out tones, may need another method instead.

`qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by Kazuhiko Arase (MIT).
`jsQR.js` is [jsQR](https://github.com/cozmo/jsQR) 1.4.0 by Cosmo Wolfe (Apache-2.0), its `dist/jsQR.js` build.
`client-zip.js` is [client-zip](https://github.com/Touffy/client-zip) 2.5.1 by David Junger (MIT), its `worker.js` build.
`idb-keyval.js` is [idb-keyval](https://github.com/jakearchibald/idb-keyval) 6.3.0 by Jake Archibald (Apache-2.0), its `dist/umd.js` build.
All four are unmodified; their full license texts are in [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES).
