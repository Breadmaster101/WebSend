// Settings the rest of the app shares.

// Finds public addresses across networks; [] = same-LAN only, no third party at all. Two servers let the log spot
// networks that give each destination a different public port (symmetric NAT), which blocks direct connections.
export const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
export const CHUNK = 64 << 10, BIG = 256 << 10;         // send 64 KB messages, or 256 KB once the other device says it takes them
export const SEG = 4 << 20;                             // hand files to lanes 4 MB at a time, each with its own checksum
export const HIGH = 8 << 20, LOW = 1 << 20;             // send-buffer backpressure
export const LANES = 3;                                 // most connections files travel over (see grow() in lanes.js)
export const BATCH = 200;                               // files per control message (keeps messages small)
export const PROTO = 2;                                 // both devices must speak the same version (2: checksums)
export const KEEP = 24 * 3600e3;                        // how long an unfinished download is kept to resume after a crash
