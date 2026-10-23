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
- **Rating scales (likert)**: statements rated agree–disagree or on a numeric
  scale, shown as diverging bars or histograms.
- **Two layouts**: `classic` (vote buttons, then a Chart.js chart on a results
  slide) and `embedded` (the whole question on one slide: bars fill live, with
  the QR code, URL, response count and a LIVE/CLOSED status beside them).
- **QR codes** on the slide, plus **Shift+Q** for a full-screen QR at any time.
- **Presenter controls in the revealjs menu**: a "Live poll" tab beside Slides
  and Tools (Shift+L opens it).
- **Password-protected hosting**: only someone with the password behind the
  room's bcrypt hash can host; everyone else follows along.
- **A participant page, `poll.html`**, that configures itself from the deck.
- **Session recording**: Alt+R saves the class's answers to `session.json`;
  re-render with it beside the deck and the results are back on the slides.

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

## Installing

In your project folder:

```bash
quarto add adam-coates/seminar-quarto@master
```

This installs the extension into `_extensions/adam-coates/livepoll/`.
`quarto update adam-coates/seminar-quarto` updates it later;
`quarto add adam-coates/seminar-quarto@<tag or branch>` installs a
particular version.

The audience's page, `poll.html`, has to sit beside each rendered deck. Let
the extension's post-render script put it there:

```yaml
# _quarto.yml
project:
  post-render:
    - _extensions/adam-coates/livepoll/copy-poll-page.lua
```

(Without a project, copy `_extensions/adam-coates/livepoll/poll.html` next to
the rendered deck yourself.)

Then enable it in the deck:

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

### Rating scales

```markdown
## How did today go?

::: {.likert #feedback scale="agree-5"}
- The pace of today's lecture was right
- The examples helped
- I could follow the live coding
:::
```

Each list item is a statement, all rated on the same scale; without a list the
question itself is the one statement. Phones show a row of choices per
statement and send them together.

| `scale=` | points |
| --- | --- |
| `agree-5` (default) | Strongly disagree, Disagree, Neutral, Agree, Strongly agree |
| `agree-7` | adds Somewhat disagree and Somewhat agree |
| `0-10`, `1-5`, … | numeric, up to 11 points; `low="…"` and `high="…"` name the ends |

`labels="Too slow|Just right|Too fast"` gives the points yourself (2 to 11,
separated by `|`).

```markdown
::: {.likert #confidence scale="0-10" low="Not at all" high="Completely"}
How confident are you running a t-test in R?
:::
```

In the embedded layout a worded scale is drawn as one diverging bar per
statement (disagree left of the line, agree right) and a numeric scale as a
histogram per statement with its mean and median. In the classic layout the
question slide has a row of buttons per statement and a Submit button, like a
classic poll's buttons, and a `.poll-results for="feedback"` slide shows a
stacked bar chart.

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

Word clouds and rating scales take `layout="embedded"` too, and get the same
side column. `results="hidden"` and `qr="false"` work on rating scales as well.

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
| `for` | `.poll-results` | the poll's or rating scale's id (required) |
| `orientation` | `.poll-results` | `horizontal` (default) or `vertical`, for polls and rating scales |
| `height` | `.poll-results`, `.wordcloud` | box height, default `360px` |
| `show-question` | `.poll`, `.poll-results`, `.wordcloud`, `.likert` | print the question (or not) |
| `size`, `url`, `caption` | `.poll-qr` | QR size in px, a different target, `caption="false"` hides the URL |

### Styling the charts

Each `.poll-results` chart can be styled on its own:

```markdown
::: {.poll-results for="feedback" orientation="vertical" x-tick-size="20" y-tick-size="14" legend="right" legend-size="13" color="#444" grid-color="#eee" label-wrap="14"}
:::
```

| attribute | what it sets |
| --- | --- |
| `font-size` | all of the chart's text: both axes and the legend |
| `x-tick-size`, `y-tick-size` | the bottom and the left axis labels, overriding `font-size` |
| `legend-size` | the legend text, overriding `font-size` |
| `legend` | `top`, `bottom`, `left`, `right`, or `false` to hide it (rating scales; a poll chart has no legend) |
| `color` | the colour of the chart's text |
| `grid-color` | the colour of the grid lines |
| `label-wrap` | wrap option and statement labels at about this many characters |

Sizes are in pixels (`18` or `18px`). x and y are the chart's own axes, so
in a horizontal chart x is the counts and y the options or statements; in a
vertical chart it is the other way round.

The same settings under `livepoll: chart:` apply to every chart in the deck,
and a chart's own attributes override them:

```yaml
livepoll:
  chart:
    color: "#444"
    font-size: 18
```

Unstyled, a poll chart uses the extension's chart defaults (30px text) and a
rating-scale chart 16px text with the legend at the bottom.

`chartjs` and `panel` are accepted as older names for `classic` and
`embedded`.

## Presenting

| key | what it does |
| --- | --- |
| Shift+L | open or close the Live poll tab in the menu |
| Shift+Q | full-screen QR code for the poll page (click or Esc closes it) |
| Alt+R | save the session: downloads `session.json` (see below) |
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
| `session` | `session.json` | the recording to replay; `false` turns replay off |

## Recording a session

The vote tallies live only in the presenter's browser while the class runs.
To keep them, press **Alt+R** in the presenting window before you close it:
a `session.json` downloads with every poll's counts, every word cloud's words,
every rating scale's answers and, if the deck uses the
[Excalidraw](https://github.com/parmsam/quarto-excalidraw) overlay, the
drawings made over each slide.

Put that file next to the deck's `.qmd` and render again. The deck then opens
showing what the room answered: bars and charts filled in, response counts
set, word clouds drawn. No server is needed to view it.

- Polls nobody voted in, empty clouds and unanswered rating scales are left
  out of the file.
- A rating scale is only replayed if its statements and scale points still
  match the recording; otherwise it is a render warning.
- Results are matched to polls by `#id`, so keep the ids when editing a deck
  after class. An id that has gone from the deck is a render warning.
- Present the re-rendered deck and press Alt+R again, and the replayed results
  are carried into the new file. Hosting live starts a poll afresh: its first
  new vote replaces the replayed numbers.
- `window.plateSession.build()` in the browser console returns what Alt+R
  would save, without downloading it.

The file is plain JSON (`version: 1`), so you can also write or correct one
by hand:

```json
{
  "version": 1,
  "polls": [
    { "id": "capital", "voters": 22,
      "options": [ { "label": "Sydney", "votes": 7 }, { "label": "Canberra", "correct": true, "votes": 15 } ] }
  ],
  "clouds": [
    { "id": "today", "words": [ { "word": "fun", "count": 4 } ] }
  ],
  "likerts": [
    { "id": "speed", "voters": 18, "counts": [ [4, 10, 4] ] }
  ]
}
```

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
version (`livepoll-1.7.1/`), with no cache-busting. If you change the
extension's CSS or JavaScript, bump `version` in `livepoll.lua`'s
`add_html_dependency` call, or browsers that have seen the old files keep
using them.
