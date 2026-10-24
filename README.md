# livepoll: live polls, Q&A and quizzes for Quarto revealjs

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
  revealed on cue (on the slide and on every phone). One choice or several.
- **Peer instruction**: ask the same poll again after a discussion
  (`rounds="2"`); the slide shows where round 1 was beside round 2.
- **Estimates** (a number: histogram, median, the answer as a line),
  **rankings** (put items in order) and **hotspots** (tap a point on an
  image: a heat map of the taps).
- **Word clouds**: words animate and grow as they are submitted.
- **Rating scales (likert)**: statements rated agree–disagree or on a numeric
  scale, shown as diverging bars or histograms.
- **Two layouts**: `classic` (vote buttons, then a Chart.js chart on a results
  slide) and `embedded` (the whole question on one slide: bars fill live, with
  the QR code, URL, response count and a LIVE/CLOSED status beside them).
- **Timers**: `timer="60"` counts down on the slide and the phones, closes
  voting, then steps to the answer.
- **Audience questions**: a Questions tab on the poll page, open all session,
  with upvotes; moderate them, mark them answered, put one up full screen, or
  show the board on a `.qa` slide.
- **Signals and reactions** (optional): "You've lost me" / "Slow down" buttons
  that only the presenter sees counted, and emoji reactions that float up the
  slide.
- **Quiz mode**: nicknames, points for right (and fast) answers, a private
  result on every phone, and a `.leaderboard` slide.
- **A presenter-only display** in the speaker view (S) and the Live poll tab:
  the open question, responses out of people connected, the timer, signals,
  the top questions.
- **QR codes** on the slide, plus **Shift+Q** for a full-screen QR at any time.
- **Presenter controls in the revealjs menu**: a "Live poll" tab beside Slides
  and Tools (Shift+L opens it).
- **Password-protected hosting**: only someone with the password behind the
  room's bcrypt hash can host; everyone else follows along.
- **A participant page, `poll.html`**, that configures itself from the deck.
- **Session recording**: Alt+R saves the class's answers to `session.json`;
  re-render with it beside the deck and the results are back on the slides.
  Results are **autosaved** in the presenting browser as they come in, and
  offered back after a crash.
- **Data for analysis**: every response with its time, as JSON or CSV, and a
  report template (`report.qmd`) that charts one class or compares several.

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

**Several choices.** `max-choices="2"` lets each person pick up to two;
`multiple="true"` any number. Phones get toggles and a Submit button, and the
percentages are of the people who answered. Mark every right option with
`- [x]`: with several choices a person is right only if they picked exactly
those.

```markdown
::: {.poll #primes max-choices="3"}
- [x] 2
- [x] 3
- [ ] 9
- [x] 11
:::
```

**Rounds (peer instruction).** `rounds="2"` adds a step to the slide: vote,
let people talk it over with a neighbour, press space, and everyone votes
again. The bars then show round 2, with a marker where each option stood in
round 1; the phones remind people what they said. The answer comes after the
last round. **New round** in the Live poll tab gives any poll another round
on the spot.

```markdown
::: {.poll #ci rounds="2" timer="60"}
A 95% confidence interval for a mean is (4.1, 5.3). Which is right?

- [ ] There is a 95% chance the true mean is in (4.1, 5.3)
- [x] 95% of intervals built this way contain the true mean
:::
```

### Word clouds

```markdown
## One word for today?

::: {.wordcloud #today max-words="2"}
:::
```

`max-words` is how many words each person may send (default 3; the host
enforces it too). **Reset results** in the Live poll tab wipes a cloud.

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

### Estimates

```markdown
::: {.estimate #beans min="0" max="1000" answer="412" tolerance="10%"}
How many jelly beans are in the jar?
:::
```

People type a number (and get a slider when there is a `min` and `max`). The
slide draws a histogram of the guesses with the median marked; revealing the
answer draws it as a line and counts the guesses within `tolerance` (a number
either side, or a percentage of the answer). `unit="%"` labels the numbers;
`bins="10"` sets the number of bars.

### Rankings

```markdown
::: {.rank #revisit top="3"}
What should we go over again?

- Sampling distributions
- Confidence intervals
- Power
- Regression
:::
```

People tap the items in order (`top="3"`: only their first three). The slide
sorts the items by points — first place earns the most — and they slide into
their new places as the order changes, with each item's average place and how
often it came first.

### Hotspots

```markdown
::: {.hotspot #outlier answer="0.75,0.80,0.05"}
Tap the point that does not fit.

![](images/scatter.svg)
:::
```

People tap a point on the image; the slide shows a heat map of the taps.
`answer="x,y,r"` is a circle — its centre as fractions of the image's width
and height, its radius as a fraction of the width — drawn when the answer is
revealed, with how many taps fell inside it.

Estimates, rankings and hotspots are always drawn in the embedded layout, and
a `.poll-results for="…"` div draws one on another slide.

### Timers

`timer="60"` on any question counts down from when it opens, on the slide
(a ring) and on the phones (a bar). When time is up voting closes, and the
deck steps to the slide's next livepoll step — the answer, the hidden results,
or the next round. `on-timeout="close"` only closes. **Shift+T** pauses and
resumes (or gives an untimed question 60 s); the Live poll tab has +15 s and
End now. Stepping back to a question whose time ran out does not reopen it;
**Re-open** does.

### Audience questions

The poll page has a **Questions** tab all session: anyone can ask (up to five
each) and upvote other people's. The Live poll tab lists them, most upvoted
first, where you mark them answered (✓), hide them (✕), or **Show** one full
screen on the projector (click or Esc closes it). The top two are in the
speaker view too. A slide can show the board:

```markdown
## Your questions

::: {.qa max="6"}
:::
```

`livepoll: qa: moderated` holds every question back until you **Approve** it;
`qa: false` turns questions off.

### Signals and reactions

Both are off unless you turn them on:

```yaml
livepoll:
  signals: true     # the "Lost me" / "Slow down" buttons
  reactions: true   # the emoji reactions
```

A bar at the foot of the poll page then has **😕 Lost me** and **🐢 Slow down**,
and/or six emoji reactions. A signal counts for two minutes (`signal-window:`)
unless taken back, and is shown only to you: in the Live poll tab and the
speaker view, in red once more than a couple of people, or a tenth of the
room, are signalling. **Clear signals** resets them. Reactions float up the
right-hand side of the projected slide.

### Quiz mode

```yaml
livepoll:
  quiz: true
```

Phones ask for a nickname (skipping makes you a numbered player). When a
question's answer is revealed, each right answer scores 1000 points — on a
timed question, from 1000 for an instant answer down to 500 at the bell — and
every phone is told its result, total and place. What counts as right: a
poll's marked option(s), an estimate within its `tolerance`, a tap inside a
hotspot's circle. A `.leaderboard` slide shows the top ten (`top="5"` for
fewer):

```markdown
## Leaderboard

::: {.leaderboard}
:::
```

The Live poll tab lists the players; **Rename** replaces a nickname you would
rather not see on the projector.

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
| Shift+T | pause / resume the open question's timer (or start 60 s) |
| Alt+R | save the session: downloads `session.json` (see below) |
| space | step to the next round, the answer, or the results when they are hidden |
| S | speaker view, with the live display under the timer |

Opening a poll's slide makes it the live poll, so there is normally nothing to
click; leaving the slide does not close it. Set `livepoll: auto-activate:
false` to activate polls by hand from the Live poll tab instead.

The Live poll tab (Shift+L) has, from the top:

- **Live now**: the open question, its responses out of the people connected,
  the timer, the signals and the top audience questions. The same box sits in
  the speaker view (S), so you can keep an eye on it without the projector
  showing it.
- **Poll control**: activate and deactivate, **Close voting** (the question
  stays up, answers stop), **Re-open**, **New round** and **Reset results**,
  for the selected question or else the open one.
- **Timer**, **Questions**, **Audience signals** and **Quiz**, when those are
  on.
- **Session**: download `session.json` or a CSV, and when the results were
  last autosaved.

You can run all of this from the speaker view (S) too: the Live poll tab in its
slide preview works the presentation window — Start there and the
presentation window hosts — and Shift+T and Alt+R pressed there reach it as
well.

Other options under `livepoll:`:

| option | default | meaning |
| --- | --- | --- |
| `layout` | `classic` | the deck's default layout |
| `auto-activate` | `true` | activate a poll when its slide opens |
| `menu` | `true` | `false` keeps the controls in a floating panel (with a 📡 button) instead of the menu |
| `position` | `top-right` | where that button sits: `top-left`, `bottom-right`, `bottom-left`, `hidden` |
| `session` | `session.json` | the recording to replay; `false` turns replay off |
| `qa` | `true` | audience questions; `moderated` to approve each, `false` for none |
| `signals` | `false` | the "Lost me" / "Slow down" buttons |
| `signal-window` | `120` | seconds a signal lasts |
| `reactions` | `false` | the emoji reactions |
| `quiz` | `false` | nicknames, scores and the leaderboard |
| `ids` | `session` | what `session.json` says about who answered: see [Privacy](#privacy) |

## Recording a session

The vote tallies live in the presenter's browser while the class runs. They
are **autosaved** there (in `localStorage`) a second after every change, so a
crashed tab, a flat battery or a closed window loses nothing: open the deck
again in the same browser and it offers to **Restore** them, before or after
you start hosting. Everyone who already answered stays answered. Closing the
window with results you have not saved gets the browser's "Leave page?"
question.

To keep them for good, press **Alt+R** (or **Download session.json** in the
Live poll tab) in the presenting window before you close it:
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

Since 2.0 the file also has every response with its time (`responses`),
when each question opened (`opened`), the rounds of a poll asked more than
once, the raw answers to estimates, rankings and hotspots, the audience's
questions, the quiz leaderboard, and the signals and reactions with the slide
they came on. Estimates, rankings, hotspots, rounds, questions and the
leaderboard are replayed too.

**Download CSV** in the Live poll tab gives the responses as a table, one row
per answer — time, seconds since the question opened, question, round,
participant, answer — ready for `read.csv()` or pandas.

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

### The report

`_extensions/adam-coates/livepoll/report.qmd` is a report on what the room
said: every poll, estimate, ranking, rating scale and cloud as a chart, who
changed their mind between rounds (wrong → right, and so on), how quickly
people answered, responses over the session, where people pressed "Lost me",
the audience's questions and the leaderboard. Copy it next to your
`session.json` files, list them at the top, and `quarto render report.qmd`.
Given several classes it also plots each question's share of right answers
across them. It runs in the browser (Observable JS), so there is nothing to
install.

## Privacy

Nobody signs in and no names are asked for (bar an optional quiz nickname).
Each browser keeps a random id, in `localStorage`, which is what stops a
reload from voting twice; the presenting browser sees these ids, but they are
not people's names. What `session.json` and the CSV say about who answered is
set by `livepoll: ids:`

| `ids:` | participants are | so you can |
| --- | --- | --- |
| `session` (default) | `p1`, `p2`, … in the order they first answered | follow one person through a class (did they change their mind?), not across classes |
| `persistent` | a hash of the browser's id, salted with the venue | follow the same browser across the classes of a course |
| `none` | not recorded | see totals and times only |

Quiz nicknames are written into the leaderboard. If you mean to publish
anything drawn from these files, check what your institution asks of you
first; `persistent` ids combined with nicknames may well count as personal
data.

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
- Only the host's word counts. The relay lets anyone in the room send a
  message to everyone else, so neither the phones nor the decks take a
  participant's word for anything shown to the room: activations, results,
  timers and the like are only believed when the host *announces* them, which
  the relay allows no one else to do. The host takes answers from
  participants, and checks them.

## Browser caching

Quarto serves extension files from a fixed path that includes the extension's
version (`livepoll-2.0.2/`), with no cache-busting. If you change the
extension's CSS or JavaScript, bump `version` in `livepoll.lua`'s
`add_html_dependency` call, or browsers that have seen the old files keep
using them.
