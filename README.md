# livepoll: live polls and word clouds for Quarto revealjs

A Quarto extension that turns a revealjs deck into a live classroom tool. The
presenter hosts a room on a [seminar](https://github.com/rajgoel/seminar)
socket.io server, the audience scans a QR code and votes from their phones, and
the results appear on the slide as they come in.

Built on the [Seminar](https://github.com/rajgoel/reveal.js-plugins/tree/master/seminar)
and Poll plugins from reveal.js-plugins. It needs no post-processing script: the
deck's front matter is all the configuration there is.

> The earlier version of this repo (Seminar plus `postprocess.py`) is kept on
> the [`old`](https://github.com/adam-coates/seminar-quarto/tree/old) branch.

## Features

- **Polls** from a plain Markdown list, with an optional correct answer that is
  revealed on cue (on the slide and on every phone).
- **Word clouds**: words animate and grow as they are submitted.
- **Two layouts**: `classic` (vote buttons, then a Chart.js chart on a results
  slide) and `embedded` (the whole question on one slide: bars fill live, with
  the QR code, URL, response count and a LIVE/CLOSED status beside them).
- **QR codes** on the slide, plus **Shift+Q** for a full-screen QR at any time.
- **Presenter controls in the revealjs menu**: a "Live poll" tab beside Slides
  and Tools (Shift+L opens it).
- **Password-protected hosting**: only someone with the password behind the
  room's bcrypt hash can host; everyone else follows along.
- **A participant page, `poll.html`**, that configures itself from the deck.

## Quick start

```bash
quarto render          # renders index.qmd and puts poll.html beside it
python3 -m http.server 8080
```

Open <http://localhost:8080/>, then the menu (bottom left) → **Live poll**,
enter the host password and press **Start**. Participants open the QR code's
address, `poll.html`.

The demo's `hash` is a placeholder, so hosting is refused until you put in your
own (see [Password](#password)).

## Using it in your own project

Copy `_extensions/livepoll/` into your project, then:

```yaml
# _quarto.yml: put poll.html beside every rendered deck
project:
  post-render:
    - _extensions/livepoll/copy-poll-page.lua
```

```yaml
# the deck's front matter
format:
  revealjs:
    revealjs-plugins:
      - livepoll
filters:
  - livepoll
seminar:
  server: "https://your-seminar-server/"
  url: "my-course"        # the venue; rooms are namespaced under it
  room: "week-01"
  hash: "$2a$05$..."      # bcrypt hash of the host password
livepoll:
  layout: embedded        # classic (default) | embedded
```

`seminar:` must be at the **top level**, not under `format: revealjs:`: the
filter reads it to configure `poll.html`. Both `revealjs-plugins:` and
`filters:` are needed. In a project, `seminar:` can live in `_quarto.yml` and a
deck can override single keys (typically just `room`).

## Writing questions

### Polls

```markdown
## What is the capital of Australia?

::: {.poll #capital}
- [ ] Sydney
- [x] Canberra
- [ ] Melbourne
:::
```

- `- [x]` marks the correct answer (`[label]{.correct}` works too). Press
  space to reveal it: the correct option turns green on the slide and every
  phone shows it.
- The question is the `question="…"` attribute, else text inside the div, else
  the slide heading.
- `#id` is optional, but it is what `.poll-results for=` refers to and what the
  control panel lists.

### Word clouds

```markdown
## One word for today?

::: {.wordcloud #today max-words="2"}
:::
```

`max-words` is how many words each person may send (default 3). **Clear
words** in the Live poll tab wipes a cloud.

## Layouts

Set the layout for the whole deck with `livepoll: layout:`, or for one question
with `layout="…"` on its div. A deck can mix both.

### `embedded`

Everything on one slide: options as bar rows that fill as votes arrive, and a
side column with the QR code, the URL, the response count and a LIVE / CLOSED /
OFFLINE status with the number of people connected.

```markdown
::: {.poll #pvalue layout="embedded" results="hidden"}
A p-value of 0.03 means:

- [ ] There is a 3% chance the null hypothesis is true
- [x] Data this extreme would occur 3% of the time if the null were true
:::
```

| attribute | meaning |
| --- | --- |
| `results="hidden"` | keep the bars blank until the answer is revealed (or, without an answer, until the next fragment) |
| `qr="false"` | leave the QR code out of the side column |
| `letters="true"` | label options A., B., C. (off by default in this layout) |

Word clouds take `layout="embedded"` too, and get the same side column.

### `classic`

Vote buttons on one slide, and the chart wherever you put a `.poll-results` div
(usually the next slide). The QR code goes wherever you put a `.poll-qr` div.

```markdown
::: {.poll #q1 layout="classic"}
Which of these is a systematic error?

- [x] a scale that always reads 3 kg heavy
- [ ] a scale that wobbles by ±0.2 kg
:::

## Results

::: {.poll-results for="q1" show-question="true"}
:::
```

| attribute | on | meaning |
| --- | --- | --- |
| `for` | `.poll-results` | the poll's id (required) |
| `orientation` | `.poll-results` | `horizontal` (default) or `vertical` |
| `height` | `.poll-results`, `.wordcloud` | box height, default `360px` |
| `show-question` | `.poll`, `.poll-results`, `.wordcloud` | print the question (or not) |
| `size`, `url`, `caption` | `.poll-qr` | QR size in px, a different target, `caption="false"` hides the URL |

`chartjs` and `panel` are accepted as older names for `classic` and
`embedded`.

## Presenting

| key | what it does |
| --- | --- |
| Shift+L | open or close the Live poll tab in the menu |
| Shift+Q | full-screen QR code for the poll page (click or Esc closes it) |
| space | step to the answer (or the results, when they are hidden) |

Opening a poll's slide makes it the live poll, so there is normally nothing to
click; leaving the slide does not close it. Set `livepoll: auto-activate:
false` to activate polls by hand from the Live poll tab instead.

Other options under `livepoll:`:

| option | default | meaning |
| --- | --- | --- |
| `layout` | `classic` | the deck's default layout |
| `auto-activate` | `true` | activate a poll when its slide opens |
| `menu` | `true` | `false` keeps the controls in a floating panel (with a 📡 button) instead of the menu |
| `position` | `top-right` | where that button sits: `top-left`, `bottom-right`, `bottom-left`, `hidden` |

## Password

The host password is never stored, only its bcrypt hash. To make one:

```bash
uv run --with bcrypt python -c "import bcrypt;print(bcrypt.hashpw(b'YOURPASS', bcrypt.gensalt(rounds=5, prefix=b'2a')).decode())"
```

Use a password you use nowhere else: the hash is in the deck's HTML, and five
rounds is quick to brute-force.

## Hosting

The deck, `index_files/` and `poll.html` are static files and can go on any
static host.

- **Serve `poll.html` from the same folder as the deck.** It fetches the deck
  to read its configuration (`?deck=name.html` picks a deck other than
  `index.html`).
- **HTTPS everywhere or nowhere.** On an HTTPS site the seminar server must be
  HTTPS too, or the browser blocks the socket.
- The QR code points wherever the deck is served from. Opened from
  `http://localhost`, it points at localhost, which a phone cannot reach.
- The correct answers are in the deck's HTML. Fine for a lecture quiz, not for
  graded assessment.
- Give each session its own `room`, or two decks pool their votes.

## Browser caching

Quarto serves extension files from a fixed path that includes the extension's
version (`livepoll-1.4.0/`), with no cache-busting. If you change the
extension's CSS or JavaScript, bump `version` in `livepoll.lua`'s
`add_html_dependency` call, or browsers that have seen the old files keep
using them.
