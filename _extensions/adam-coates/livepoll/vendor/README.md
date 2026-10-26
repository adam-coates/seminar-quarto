# Vendored libraries

Served with the extension instead of from a CDN, so that neither the deck nor
the audience's phones contact third parties: every CDN request hands the
participant's IP address to the CDN's operator. It also keeps polls working on
a network without internet access.

| File | Package | Licence |
|---|---|---|
| `socket.io.min.js` | socket.io-client 4.8.4 (`dist/socket.io.min.js`) | MIT |
| `chart.min.js` | chart.js 3.9.1 (`dist/chart.min.js`) | MIT |
| `poll-style.css` | reveal.js-plugins 4.6.0 (`poll/style.css`) | MIT |
| `wordlists.js` | LDNOOBW `en` and `de` lists, commit 5faf2ba42d7b (GitHub, not npm) | CC-BY-4.0 |

Each package's licence text is in `licenses/<package>.txt`.

Keep the socket.io client on the server's major version (4). Chart.js stays on
3.x: `chart.js` (the RevealChart plugin) is written against its v3 API.

`wordlists.js` (the word filter's lists) is not updated automatically.

`.github/workflows/update-vendor.yml` checks npm weekly for newer releases
within those major versions and opens a pull request that updates the files,
this table, the licence texts and the dependency version in `livepoll.lua`.
