# Tests

Browser tests for the extension. `run.sh` renders the decks in `decks/` and
the repository's demo deck (`index.qmd`) with this checkout's extension,
starts a local relay and web servers, then drives a presenter and several
phones through each suite in headless Chrome.

```bash
cd tests && npm ci && cd ..   # once
tests/run.sh                  # every suite
tests/run.sh polls hide       # just these
```

Needs `quarto`, `node`, `python3` and Chrome or Chromium. Set `CHROME_PATH` if
the browser isn't at `/usr/bin/chromium`, and `QUARTO` if `quarto` isn't on
the `PATH`. Ports 4433, 8080 and 8081 must be free. Logs, screenshots and the
exported session go to `tests/out/`.

Every suite also fails if any page requests something other than localhost,
so the extension can't quietly start loading from a CDN again. The one
allowed exception is Quarto's own MathJax.

| Folder | What |
|---|---|
| `suites/` | the test suites; `lib.js` has the shared helpers |
| `decks/` | test decks covering every question kind; `session.json` is a replay fixture |
| `relay/` | the original seminar relay server by Asvin Goel (MIT, see `relay/LICENSE`), which the deck and phones connect to |

GitHub Actions runs the suites on every pull request and push to `master`
(`.github/workflows/tests.yml`).
