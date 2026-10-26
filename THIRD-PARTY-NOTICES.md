# Third-party components

These files are by other authors, also under the MIT License, and keep their
own copyright notices:

- _extensions/adam-coates/livepoll/seminar.js, poll.js and chart.js: based on
  the seminar, poll and chart plugins of reveal.js-plugins,
  Copyright (c) Asvin Goel (https://github.com/rajgoel/reveal.js-plugins)
- _extensions/adam-coates/livepoll/qrcode.js: QR Code Generator,
  Copyright (c) 2009 Kazuhiko Arase
- _extensions/adam-coates/livepoll/vendor/: socket.io-client, Chart.js and
  the reveal.js-plugins poll stylesheet; licence texts in vendor/licenses/
- tests/relay/server.js: the seminar relay server,
  Copyright (c) 2021 Asvin Goel; licence text in tests/relay/LICENSE

Not in this repository, but built into every rendered deck that uses the
word filter: the English and German lists of "List of Dirty, Naughty, Obscene
and Otherwise Bad Words"
(https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words),
Creative Commons Attribution 4.0
(https://creativecommons.org/licenses/by/4.0/). livepoll.lua downloads them
from a pinned commit when the deck is rendered, and the rendered deck credits
them in its configuration.
