// Small helpers used throughout.
export const $ = id => document.getElementById(id);
export const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
export const fmt = b => { let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i]; };
export const rid = () => Math.random().toString(36).slice(2);
export const why = e => e instanceof Error || e instanceof DOMException ? `${e.name}: ${e.message}` : String(e);
export const wait = ms => new Promise(r => setTimeout(r, ms));
export const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export const sha = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
