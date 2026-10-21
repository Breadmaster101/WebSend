// ---------- Protocol ----------
// Control messages are JSON on the main channel. File bytes go between a segment's 'seg' and 'sum' on any channel
// (see transfer.js). This module imports nothing else of the app's, so the others can add handlers as they load.
import { BATCH } from './config.js';

export let dc; // the main channel, which the first connection opens
export const setDc = ch => dc = ch;

// Handlers by message type. Each part of the app adds the messages it deals with; see onMessage() in peer.js.
export const on = {};

export const send = m => dc?.readyState === 'open' && dc.send(JSON.stringify(m));
export const sendIn = (msg, key, arr) => { for (let i = 0; i < arr.length; i += BATCH) send({ ...msg, [key]: arr.slice(i, i + BATCH) }); };
