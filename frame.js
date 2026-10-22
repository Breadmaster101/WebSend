'use strict';
// Refuses to run inside another site's frame. A site that framed WebSend could hand it the site's own invite in the
// URL and lay fake buttons over the real ones to get "Yes, it matches" or Download clicked. The usual defence, CSP
// frame-ancestors, only works as an HTTP header, which static hosts such as GitHub Pages can't send.
// This script runs before anything else on the page. It swaps the page for a short note, and everything after it,
// scripts included, gets read into the old page, which is no longer in the document, so none of it ever runs.
if (top !== self) {
  const a = Object.assign(document.createElement('a'), {
    href: location.origin + location.pathname, // without the code, which came from whoever framed it
    target: '_blank', rel: 'noopener noreferrer', textContent: 'Open WebSend in its own tab',
  });
  const html = Object.assign(document.createElement('html'), { lang: 'en' }), body = document.createElement('body'), p = document.createElement('p');
  p.append("WebSend doesn't run inside other pages. ", a, '.');
  body.append(p);
  html.append(document.createElement('head'), body);
  document.documentElement.replaceWith(html);
}
