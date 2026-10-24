-- livepoll — live polls for reveal.js decks, as a Quarto extension.
--
-- Authoring:
--
--     ::: {.poll #q1}
--     Which of these is a systematic error?
--
--     - [x] a scale that always reads 3 kg heavy
--     - [ ] a scale that wobbles by ±0.2 kg
--     :::
--
--     ::: {.poll-results for="q1"}
--     :::
--
--     ::: {.poll-qr}
--     :::
--
--     ::: {.wordcloud #w1 max-words="3"}
--     Describe today's session in one word.
--     :::
--
-- Two layouts. `classic` (the default) is the above: buttons on one slide, the
-- chart on a `.poll-results` slide, the QR wherever `.poll-qr` is put.
-- `embedded` puts the whole question on one slide: each option is a row whose bar fills
-- as votes arrive, with the QR code, the URL and the response count in a column
-- on the right. Word clouds get the same side column. Choose per div with
-- `layout="embedded"`, or for the whole deck with top-level `livepoll: layout:`.
-- An embedded poll takes `results="hidden"` to keep the bars blank until the answer
-- (or, without one, the next fragment) is shown, and `qr="false"` to drop the QR.
--
-- `- [x]` marks the correct answer; `[label]{.correct}` does the same, and
-- `[label]{value="X"}` overrides the auto-assigned A/B/C/D. The question is the
-- `question=` attribute, else the first paragraph in the div, else the heading
-- above it. The older raw-HTML `<div class="poll">` markup still works.
--
-- At render time this filter also:
--   * injects the CDN dependencies + the control panel into <head>
--   * publishes a JSON block describing the room and every poll, which
--     poll.html reads so it never needs editing
--
-- Room details come from TOP-LEVEL metadata (not under `format:`, which the
-- filter cannot see):
--
--     seminar:
--       server: "https://my-server/"
--       url: "my-course"
--       room: "week-01"
--       hash: "$2a$05$..."

-- Note what is deliberately NOT here: reveal.js-plugins@latest/poll/plugin.js.
-- It was, and it quietly won. Both it and this extension's own poll.js open with
--
--     window.RevealPoll = window.RevealPoll || { ... }
--
-- and this block goes into <head>, so the CDN copy was always the one that set
-- the global and the local file — the one with the late-joiner relay, the
-- activate-poll handling and the vote counting — never ran at all. Worse, that
-- was contingent: with jsDelivr slow or blocked the local file won instead, so
-- the deck ran different poll code depending on the room's network. The
-- stylesheet is still wanted; the script is not.
local cdn = [[
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.6.1/socket.io.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js-plugins@latest/poll/style.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.2.0/chart.min.js"></script>
]]

local LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
local CHECKED = "☒" -- pandoc's rendering of "- [x]"
local UNCHECKED = "☐" -- ... and of "- [ ]"

local POSITIONS = {
  ["top-right"] = true,
  ["top-left"] = true,
  ["bottom-right"] = true,
  ["bottom-left"] = true,
  ["hidden"] = true,
}

-- Layout names as written -> the layout they mean. `chartjs` and `panel` are
-- earlier names, and `embeded` a spelling, all still accepted. Internally the
-- embedded layout is still called "panel" (the lp-* classes, livepoll.css).
local LAYOUTS = {
  classic = "classic",
  chartjs = "classic",
  embedded = "panel",
  embeded = "panel",
  panel = "panel",
}

-- Deck-wide default, from top-level `livepoll: layout:`. Read in pass 1's Meta,
-- which runs after pass 1's Divs but before pass 2 generates anything.
local default_layout = "classic"

local polls = {}       -- id -> { question, options, correct }
local poll_order = {}  -- ids in slide order
local clouds = {}      -- id -> { question, maxWords }
local cloud_order = {}
local last_header = nil

-- Polls without an explicit #id are numbered. Pass 1 and pass 2 walk the same
-- document in the same order, so each keeps its own counter and they agree.
local collect_seq = 0
local generate_seq = 0

--------------------------------------------------------------------- helpers

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function unescape(s)
  s = s:gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')
  s = s:gsub("&#39;", "'"):gsub("&nbsp;", " "):gsub("&amp;", "&")
  return s
end

local function html_escape(s)
  return (s:gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;"))
end

local function plain(s)
  return trim(unescape((s:gsub("<[^>]*>", ""))))
end

local function is_html(fmt)
  return fmt == "html" or fmt == "html4" or fmt == "html5"
end

local function truthy(v)
  if v == nil then return nil end
  v = tostring(v):lower()
  return not (v == "false" or v == "no" or v == "0")
end

-- pandoc.utils.stringify is unsafe for metadata: strings are parsed as
-- markdown, so a bcrypt hash like $2a$05$Hthn... has its middle read as inline
-- math and the $ delimiters are dropped — a silently wrong hash, and therefore
-- a silently wrong room. Rebuild the source text instead.
local function inline_text(inl)
  local t = inl.t
  if t == "Str" then
    return inl.text
  elseif t == "Space" then
    return " "
  elseif t == "SoftBreak" or t == "LineBreak" then
    return " "
  elseif t == "Math" then
    local d = (inl.mathtype == "DisplayMath") and "$$" or "$"
    return d .. inl.text .. d
  elseif t == "Code" or t == "RawInline" then
    return inl.text
  elseif inl.content then
    local out = {}
    for _, child in ipairs(inl.content) do
      out[#out + 1] = inline_text(child)
    end
    return table.concat(out)
  end
  return pandoc.utils.stringify(inl)
end

local function inlines_text(inlines)
  local out = {}
  for _, inl in ipairs(inlines) do
    out[#out + 1] = inline_text(inl)
  end
  return trim(table.concat(out))
end

local function meta_value(v)
  if v == nil then return nil end
  if type(v) == "boolean" then return v end
  if type(v) == "string" then return v end
  if type(v) == "number" then return tostring(v) end
  if v.t == "MetaString" then return v.text end
  if v.t == "MetaBool" then return v.bool end
  return inlines_text(v)
end

local function record(id, poll)
  if not polls[id] then table.insert(poll_order, id) end
  polls[id] = poll
end

local function record_cloud(id, cloud)
  if not clouds[id] then table.insert(cloud_order, id) end
  clouds[id] = cloud
end

-- timer="60" on any question: voting closes after that many seconds, counted
-- from when the question is opened. on-timeout="reveal" (the default) then
-- steps to the slide's next livepoll step — the answer, the results or the
-- next round — and on-timeout="close" only closes.
local timers = {} -- id -> { seconds, onTimeout }

local function read_timer(el, id)
  local t = el.attributes["timer"]
  if t == nil then return nil end
  local seconds = tonumber((t:gsub("%s*s$", "")))
  if not seconds or seconds <= 0 then
    quarto.log.warning("livepoll: '" .. id .. "' timer=\"" .. t .. "\" should be a number of seconds; ignored.")
    return nil
  end
  local on_timeout = el.attributes["on-timeout"] or "reveal"
  if on_timeout ~= "reveal" and on_timeout ~= "close" then
    quarto.log.warning("livepoll: '" .. id .. "' on-timeout should be reveal or close; using reveal.")
    on_timeout = "reveal"
  end
  timers[id] = { seconds = math.floor(seconds), onTimeout = on_timeout }
  return timers[id]
end

-- The countdown ring, filled in by timer.js. `float` puts it in the corner of
-- a classic slide; in the embedded layout it sits in the side column.
local function timer_html(id, float)
  if not timers[id] then return "" end
  return '<div class="lp-timer' .. (float and " lp-timer-float" or "") .. '" data-timer="' .. html_escape(id)
    .. '" hidden><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="lp-timer-track" cx="18" cy="18" r="15.9"/>'
    .. '<circle class="lp-timer-ring" cx="18" cy="18" r="15.9" pathLength="100"/></svg>'
    .. '<span class="lp-timer-text"></span></div>'
end

-- The div's own `layout=`, or nil to take the deck default at generate time.
local function layout_attr(el, id)
  local v = el.attributes["layout"]
  if v == nil then return nil end
  if LAYOUTS[v] then return LAYOUTS[v] end
  quarto.log.warning("livepoll: '" .. id .. "' has unknown layout '" .. v .. "' (use classic or embedded), using the deck default.")
  return nil
end

-- Chart styling keys, the same as a .poll-results div takes. `livepoll:
-- chart:` in the front matter sets them deck-wide; a div's own attribute wins.
local CHART_KEYS = {
  "font-size", "x-tick-size", "y-tick-size", "legend-size",
  "legend", "color", "grid-color", "label-wrap",
}
local chart_defaults = {}

local function read_layout(meta)
  if not meta.livepoll then return nil end
  if meta.livepoll.layout then
    local v = pandoc.utils.stringify(meta.livepoll.layout)
    if LAYOUTS[v] then
      default_layout = LAYOUTS[v]
    else
      quarto.log.warning("livepoll: unknown layout '" .. v .. "' (use classic or embedded), using classic.")
    end
  end
  local chart = meta.livepoll.chart
  if chart ~= nil then
    if pandoc.utils.type(chart) ~= "table" then
      quarto.log.warning("livepoll: `chart:` should be a map of chart settings; ignored.")
    else
      for _, key in ipairs(CHART_KEYS) do
        if chart[key] ~= nil then chart_defaults[key] = tostring(meta_value(chart[key])) end
      end
    end
  end
  return nil
end

------------------------------------------------------------ pass 1: collect

-- drop leading elements while they match a predicate
local function lstrip(inlines, drop)
  local out = {}
  local dropping = true
  for _, inl in ipairs(inlines) do
    if dropping and drop(inl) then
      -- skip
    else
      dropping = false
      out[#out + 1] = inl
    end
  end
  return out
end

-- Pull one option out of a bullet-list item.
local function read_option(item)
  local first = item[1]
  if not first or not first.content then return nil end

  local inlines = first.content
  local correct = false
  local value = nil

  -- "- [x] label" / "- [ ] label": pandoc leaves a checkbox character behind
  if #inlines > 0 and inlines[1].t == "Str" then
    if inlines[1].text == CHECKED then
      correct = true
      inlines = lstrip(inlines, function(i) return i.t == "Str" and i.text == CHECKED end)
    elseif inlines[1].text == UNCHECKED then
      inlines = lstrip(inlines, function(i) return i.t == "Str" and i.text == UNCHECKED end)
    end
  end

  -- "[label]{.correct}" / "[label]{value=X}" as the whole item
  local stripped = lstrip(inlines, function(i) return i.t == "Space" end)
  if #stripped == 1 and stripped[1].t == "Span" then
    local span = stripped[1]
    if span.classes:includes("correct") then correct = true end
    if truthy(span.attributes["correct"]) then correct = true end
    if span.attributes["value"] then value = span.attributes["value"] end
    inlines = span.content
  end

  local label = inlines_text(inlines)
  if label == "" then return nil end
  return { label = label, value = value, correct = correct }
end

local function collect_div(el)
  if not el.classes:includes("poll") then return nil end

  collect_seq = collect_seq + 1
  local id = el.identifier
  if id == nil or id == "" then id = "poll-" .. collect_seq end

  local question = el.attributes["question"]
  -- where the question came from decides whether it still has to be drawn on
  -- the slide: a heading above the div is already visible, an attribute or a
  -- paragraph inside the div is not (the div is replaced wholesale).
  local q_source = question and "attribute" or nil
  local raw_options = {}

  for _, block in ipairs(el.content) do
    if block.t == "BulletList" or block.t == "OrderedList" then
      for _, item in ipairs(block.content) do
        local opt = read_option(item)
        if opt then table.insert(raw_options, opt) end
      end
    elseif (block.t == "Para" or block.t == "Plain") and not question then
      question = inlines_text(block.content)
      q_source = "paragraph"
    elseif block.t == "Header" and not question then
      question = inlines_text(block.content)
      q_source = "paragraph"
    end
  end

  if not question then q_source = "heading" end

  if #raw_options == 0 then
    quarto.log.warning("livepoll: poll '" .. id .. "' has no options; skipping.")
    return nil
  end

  -- Letter prefixes (A. / B. / ...) unless switched off, or unless every
  -- option carries an explicit value.
  local all_explicit = true
  for _, opt in ipairs(raw_options) do
    if not opt.value then all_explicit = false end
  end
  local letters = truthy(el.attributes["letters"])
  if letters == nil then letters = not all_explicit end

  -- Several choices: max-choices="N" takes up to N, multiple="true" any
  -- number (0 below). Unset, one, as always.
  local max_choices = nil
  if el.attributes["max-choices"] then
    max_choices = tonumber(el.attributes["max-choices"])
    if not max_choices or max_choices < 1 then
      quarto.log.warning("livepoll: poll '" .. id .. "' max-choices should be a number from 1; ignored.")
      max_choices = nil
    elseif max_choices == 1 then
      max_choices = nil
    end
  elseif truthy(el.attributes["multiple"]) then
    max_choices = 0
  end

  -- Every option marked [x] is correct. A one-choice poll with two marked
  -- accepts either; a several-choice poll wants exactly the marked set.
  local options, correct = {}, {}
  for i, opt in ipairs(raw_options) do
    local letter = LETTERS:sub(i, i)
    local value = opt.value or letter
    local label = opt.label
    if letters and not opt.value then label = letter .. ". " .. label end
    -- `text` is the option without its letter, which the panel layout shows
    table.insert(options, { value = value, label = label, text = opt.label })
    if opt.correct then table.insert(correct, value) end
  end

  if el.attributes["correct"] then
    correct = {}
    for v in el.attributes["correct"]:gmatch("[^,|]+") do table.insert(correct, trim(v)) end
  end
  if #correct == 0 then
    correct = nil
  elseif #correct == 1 then
    correct = correct[1]
  end

  local rounds = tonumber(el.attributes["rounds"] or "1") or 1
  if rounds < 1 then rounds = 1 end
  if rounds > 5 then
    quarto.log.warning("livepoll: poll '" .. id .. "' rounds=\"" .. rounds .. "\": at most 5; using 5.")
    rounds = 5
  end
  read_timer(el, id)

  -- The question is drawn above the buttons unless it is already on the slide
  -- as a heading, or the author switched it off.
  local show = truthy(el.attributes["show-question"])
  if show == nil then show = (q_source ~= "heading") end

  local results = el.attributes["results"]
  if results ~= nil and results ~= "live" and results ~= "hidden" then
    quarto.log.warning("livepoll: poll '" .. id .. "' results should be live or hidden, got '" .. results .. "'.")
    results = nil
  end

  record(id, {
    question = question or last_header or id,
    options = options,
    correct = correct,
    show_question = show,
    layout = layout_attr(el, id),
    -- only an explicit letters="true" letters a panel poll; nil otherwise
    letters = truthy(el.attributes["letters"]),
    results = results or "live",
    qr = truthy(el.attributes["qr"]) ~= false,
    max_choices = max_choices,
    rounds = rounds,
  })
  return nil
end

-- The correct answer as the slides and the phones carry it: one value as
-- itself, several as a JSON list (livepoll.js, LP.correctSet).
local function correct_attr(correct)
  if type(correct) == "table" then return quarto.json.encode(correct) end
  return correct
end

local function is_correct(correct, value)
  if type(correct) == "table" then
    for _, v in ipairs(correct) do
      if v == value then return true end
    end
    return false
  end
  return correct == value
end

local function collect_cloud(el)
  if not el.classes:includes("wordcloud") then return nil end

  collect_seq = collect_seq + 1
  local id = el.identifier
  if id == nil or id == "" then id = "cloud-" .. collect_seq end

  local question = el.attributes["question"]
  local q_source = question and "attribute" or nil
  for _, block in ipairs(el.content) do
    if (block.t == "Para" or block.t == "Plain" or block.t == "Header") and not question then
      question = inlines_text(block.content)
      q_source = "paragraph"
    end
  end
  if not question then q_source = "heading" end

  local show = truthy(el.attributes["show-question"])
  if show == nil then show = (q_source ~= "heading") end

  local max_words = tonumber(el.attributes["max-words"] or "3") or 3
  if max_words < 1 then max_words = 1 end
  read_timer(el, id)

  record_cloud(id, {
    question = question or last_header or id,
    maxWords = max_words,
    show_question = show,
    layout = layout_attr(el, id),
    qr = truthy(el.attributes["qr"]) ~= false,
  })
  return nil
end

----------------------------------------------------------------- likert

-- A rating scale: one or more statements, each rated on the same scale.
--
--     ::: {.likert #feedback scale="agree-5"}
--     - The pace was right
--     - The examples helped
--     :::
--
-- scale= is agree-5 (the default), agree-7, or a numeric range such as 0-10
-- or 1-5 (up to 11 points), whose ends low= and high= name. labels="a|b|c"
-- gives the points yourself. Without a list the question is the one statement.

local LIKERT_SCALES = {
  ["agree-5"] = { "Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree" },
  ["agree-7"] = {
    "Strongly disagree", "Disagree", "Somewhat disagree", "Neutral",
    "Somewhat agree", "Agree", "Strongly agree",
  },
}
local LIKERT_MAX_POINTS = 11

local likerts = {}      -- id -> { question, statements, labels, numeric, anchors, ... }
local likert_order = {}

local function record_likert(id, likert)
  if not likerts[id] then table.insert(likert_order, id) end
  likerts[id] = likert
end

-- (labels, numeric, anchors) from a likert div's attributes.
local function likert_scale(attrs, id)
  local labels, numeric = nil, false
  if attrs.labels ~= nil then
    labels = {}
    for part in (attrs.labels .. "|"):gmatch("([^|]*)|") do
      part = trim(part)
      if part ~= "" then table.insert(labels, part) end
    end
    if #labels < 2 or #labels > LIKERT_MAX_POINTS then
      quarto.log.warning("livepoll: likert '" .. id .. "' labels= needs 2 to "
        .. LIKERT_MAX_POINTS .. " labels separated by |; using agree-5.")
      labels = nil
    end
  else
    local scale = trim(attrs.scale or "agree-5")
    local lo, hi = scale:match("^(%d+)%s*%-%s*(%d+)$")
    if LIKERT_SCALES[scale] then
      labels = LIKERT_SCALES[scale]
    elseif lo then
      lo, hi = tonumber(lo), tonumber(hi)
      if hi - lo + 1 < 2 or hi - lo + 1 > LIKERT_MAX_POINTS then
        quarto.log.warning("livepoll: likert '" .. id .. "' scale=\"" .. scale .. "\" must span 2 to "
          .. LIKERT_MAX_POINTS .. " points (e.g. 0-10, 1-5); using agree-5.")
      else
        labels, numeric = {}, true
        for i = lo, hi do table.insert(labels, tostring(i)) end
      end
    else
      quarto.log.warning("livepoll: likert '" .. id .. "' has unknown scale=\"" .. scale
        .. "\" (use agree-5, agree-7, a range like 0-10, or labels=\"a|b|c\"); using agree-5.")
    end
  end
  labels = labels or LIKERT_SCALES["agree-5"]

  local anchors = nil
  if attrs.low ~= nil or attrs.high ~= nil then
    if numeric then
      anchors = { trim(attrs.low or ""), trim(attrs.high or "") }
    else
      quarto.log.warning("livepoll: likert '" .. id .. "': low= and high= only apply to numeric scales; ignored.")
    end
  end
  return labels, numeric, anchors
end

-- Pass 1. Returns the div with its id filled in when it had none, so pass 2
-- finds the same id without having to count likerts the same way twice.
local function collect_likert(el)
  if not el.classes:includes("likert") then return nil end

  collect_seq = collect_seq + 1
  local id = el.identifier
  if id == nil or id == "" then id = "likert-" .. collect_seq end

  local question = el.attributes["question"]
  local q_source = question and "attribute" or nil
  local statements = {}
  for _, block in ipairs(el.content) do
    if block.t == "BulletList" or block.t == "OrderedList" then
      for _, item in ipairs(block.content) do
        local first = item[1]
        local text = first and first.content and inlines_text(first.content) or ""
        if text ~= "" then table.insert(statements, text) end
      end
    elseif (block.t == "Para" or block.t == "Plain" or block.t == "Header") and not question then
      question = inlines_text(block.content)
      q_source = "paragraph"
    end
  end
  if not question then q_source = "heading" end
  question = question or last_header or id

  -- no list: the question is the one statement, and is not repeated as a label
  local single = #statements == 0
  if single then statements = { question } end

  local labels, numeric, anchors = likert_scale(el.attributes, id)
  read_timer(el, id)

  local show = truthy(el.attributes["show-question"])
  -- as for polls: printed unless the slide heading already says it (a single
  -- statement is the question, so it gets no label of its own either way)
  if show == nil then show = (q_source ~= "heading") end

  local results = el.attributes["results"]
  if results ~= nil and results ~= "live" and results ~= "hidden" then
    quarto.log.warning("livepoll: likert '" .. id .. "' results should be live or hidden, got '" .. results .. "'.")
    results = nil
  end

  record_likert(id, {
    question = question,
    statements = statements,
    labels = labels,
    numeric = numeric,
    anchors = anchors,
    single = single,
    show_question = show,
    layout = layout_attr(el, id),
    results = results or "live",
    qr = truthy(el.attributes["qr"]) ~= false,
  })

  if el.identifier == "" then
    el.identifier = id
    return el
  end
  return nil
end

------------------------------------------------- estimate, rank, hotspot

-- Three more kinds of question, all drawn in the embedded layout (livepoll.js
-- has nothing to put on a classic voting slide for them: the answering is on
-- the phones). A `.poll-results for=` div draws one on another slide.
--
--     ::: {.estimate #mean min="0" max="100" answer="42" unit="%"}
--     What share of the class owns a bicycle?
--     :::
--
--     ::: {.rank #topics top="3"}
--     Which topics should we revisit?
--     - Regression
--     - Power
--     :::
--
--     ::: {.hotspot #outlier answer="0.71,0.32,0.06"}
--     Tap the outlier.
--
--     ![](scatter.png)
--     :::

local estimates, estimate_order = {}, {}
local ranks, rank_order = {}, {}
local hotspots, hotspot_order = {}, {}
local qa_boards = 0       -- how many .qa slides; Q&A runs whether or not there is one
local leaderboards = 0

local function record_in(tbl, order, id, item)
  if not tbl[id] then table.insert(order, id) end
  tbl[id] = item
end

-- The question for any of these: question=, else the first paragraph with
-- text in it, else the slide heading. Returns the text and whether it still
-- needs printing on the slide (it does unless it is the heading).
local function question_of(el, id)
  local question = el.attributes["question"]
  local from_heading = false
  if not question then
    for _, block in ipairs(el.content) do
      if (block.t == "Para" or block.t == "Plain" or block.t == "Header") and not question then
        local only_images = true
        for _, inl in ipairs(block.content) do
          if inl.t ~= "Image" and inl.t ~= "Space" and inl.t ~= "SoftBreak" then only_images = false end
        end
        if not only_images then
          local text = {}
          for _, inl in ipairs(block.content) do
            if inl.t ~= "Image" then text[#text + 1] = inl end
          end
          question = inlines_text(text)
        end
      end
    end
  end
  if not question or question == "" then
    question = last_header or id
    from_heading = true
  end
  local show = truthy(el.attributes["show-question"])
  if show == nil then show = not from_heading end
  return question, show
end

local function results_attr(el, id)
  local results = el.attributes["results"]
  if results ~= nil and results ~= "live" and results ~= "hidden" then
    quarto.log.warning("livepoll: '" .. id .. "' results should be live or hidden, got '" .. results .. "'.")
    results = nil
  end
  return results or "live"
end

-- Ids for these are settled in pass 1 (as for rating scales), so the div is
-- handed back with its id filled in when it had none.
local function settle_id(el, prefix)
  collect_seq = collect_seq + 1
  local id = el.identifier
  if id == nil or id == "" then id = prefix .. "-" .. collect_seq end
  return id
end

local function settled(el, id)
  if el.identifier == "" then
    el.identifier = id
    return el
  end
  return nil
end

local function warn_layout(el, id)
  if el.attributes["layout"] and LAYOUTS[el.attributes["layout"]] == "classic" then
    quarto.log.warning("livepoll: '" .. id .. "' is only drawn in the embedded layout; layout=\"classic\" ignored.")
  end
end

local function collect_estimate(el)
  if not el.classes:includes("estimate") then return nil end
  local id = settle_id(el, "estimate")
  local question, show = question_of(el, id)
  local a = el.attributes
  local min, max = tonumber(a.min), tonumber(a.max)
  if min and max and min >= max then
    quarto.log.warning("livepoll: estimate '" .. id .. "' has min >= max; both ignored.")
    min, max = nil, nil
  end
  local answer = tonumber(a.answer)
  if a.answer and not answer then
    quarto.log.warning("livepoll: estimate '" .. id .. "' answer=\"" .. a.answer .. "\" is not a number; ignored.")
  end
  -- tolerance="5" (either side) or "10%" (of the answer): what counts as right
  -- in a quiz. Without one an estimate is not scored.
  local tolerance, tolerance_pct = nil, nil
  if a.tolerance then
    local pct = a.tolerance:match("^%s*([%d.]+)%s*%%%s*$")
    if pct then tolerance_pct = tonumber(pct) else tolerance = tonumber(a.tolerance) end
  end
  warn_layout(el, id)
  read_timer(el, id)
  record_in(estimates, estimate_order, id, {
    question = question,
    show_question = show,
    min = min,
    max = max,
    step = tonumber(a.step),
    answer = answer,
    unit = a.unit,
    tolerance = tolerance,
    tolerancePct = tolerance_pct,
    bins = tonumber(a.bins),
    results = results_attr(el, id),
    qr = truthy(a.qr) ~= false,
  })
  return settled(el, id)
end

local function collect_rank(el)
  if not el.classes:includes("rank") then return nil end
  local id = settle_id(el, "rank")
  local question, show = question_of(el, id)
  local items = {}
  for _, block in ipairs(el.content) do
    if block.t == "BulletList" or block.t == "OrderedList" then
      for _, item in ipairs(block.content) do
        local first = item[1]
        local text = first and first.content and inlines_text(first.content) or ""
        if text ~= "" then table.insert(items, text) end
      end
    end
  end
  if #items < 2 then
    quarto.log.warning("livepoll: rank '" .. id .. "' needs at least two items in a list; skipping.")
    return nil
  end
  local top = tonumber(el.attributes["top"] or "") or #items
  if top < 1 or top > #items then top = #items end
  warn_layout(el, id)
  read_timer(el, id)
  record_in(ranks, rank_order, id, {
    question = question,
    show_question = show,
    items = items,
    top = top,
    results = results_attr(el, id),
    qr = truthy(el.attributes["qr"]) ~= false,
  })
  return settled(el, id)
end

local function first_image(el)
  local found = nil
  pandoc.Div(el.content):walk({
    Image = function(img)
      if not found then found = { src = img.src, alt = pandoc.utils.stringify(img.caption) } end
      return nil
    end,
  })
  return found
end

local function collect_hotspot(el)
  if not el.classes:includes("hotspot") then return nil end
  local id = settle_id(el, "hotspot")
  local image = first_image(el)
  if not image then
    quarto.log.warning("livepoll: hotspot '" .. id .. "' has no image in it; skipping.")
    return nil
  end
  local question, show = question_of(el, id)
  -- answer="x,y,r": the centre as fractions of the image's width and height,
  -- the radius as a fraction of its width
  local answer = nil
  if el.attributes["answer"] then
    local x, y, r = el.attributes["answer"]:match("^%s*([%d.]+)%s*,%s*([%d.]+)%s*,%s*([%d.]+)%s*$")
    if x then
      answer = { tonumber(x), tonumber(y), tonumber(r) }
    else
      quarto.log.warning("livepoll: hotspot '" .. id .. "' answer should be \"x,y,radius\" as fractions (e.g. 0.6,0.4,0.05); ignored.")
    end
  end
  warn_layout(el, id)
  read_timer(el, id)
  record_in(hotspots, hotspot_order, id, {
    question = question,
    show_question = show,
    image = image.src,
    alt = image.alt,
    answer = answer,
    results = results_attr(el, id),
    qr = truthy(el.attributes["qr"]) ~= false,
  })
  return settled(el, id)
end

-- The diverging palette's tone for each point: which side of neutral, and how
-- far out. Mirrors the steps the CSS colours (livepoll.css, .lp-likert).
local TONE_STEPS = { [1] = { 3 }, [2] = { 2, 4 }, [3] = { 1, 3, 5 }, [4] = { 1, 2, 4, 5 }, [5] = { 1, 2, 3, 4, 5 } }

local function likert_tones(n)
  local arm = n // 2
  local steps = TONE_STEPS[arm] or TONE_STEPS[5]
  local out = {}
  for i = 0, n - 1 do
    if n % 2 == 1 and i == arm then
      out[#out + 1] = { side = "mid", step = 0 }
    else
      local away = i < arm and (arm - i) or (i - (n - arm) + 1)
      out[#out + 1] = { side = i < arm and "neg" or "pos", step = steps[away] or steps[#steps] }
    end
  end
  return out
end

local function collect_rawblock(el)
  if not is_html(el.format) then return nil end

  local tag = el.text:match('<div[^>]-class="[^"]*poll[^"]*"[^>]->')
  if not tag then return nil end
  local id = tag:match('data%-poll="([^"]+)"')
  if not id then return nil end

  local options = {}
  for value, label in el.text:gmatch('<button[^>]-data%-value="([^"]*)"[^>]*>(.-)</button>') do
    table.insert(options, { value = unescape(value), label = plain(label) })
  end
  if #options == 0 then return nil end

  local q = tag:match('data%-question="([^"]*)"')
  record(id, {
    question = q and unescape(q) or last_header or id,
    options = options,
    correct = tag:match('data%-correct="([^"]*)"'),
  })
  return nil
end

------------------------------------------------------------ pass 2: generate

local function question_html(id, text)
  return '<h3 class="poll-question" data-poll="'
    .. html_escape(id)
    .. '">'
    .. html_escape(text or polls[id].question)
    .. "</h3>"
end

-- "Pick up to 2" / "Pick any": said on the slide and on the phones.
local function choices_hint(poll)
  if poll.max_choices == nil then return nil end
  if poll.max_choices == 0 then return "Pick all that apply" end
  return "Pick up to " .. poll.max_choices
end

-- One step per round after the first. The presenter steps to it after the
-- discussion and everyone votes again (livepoll.js starts the round).
local function round_steps(id, poll, hidden)
  local out = {}
  for r = 2, poll.rounds or 1 do
    out[#out + 1] = '<p class="lp-round fragment' .. (hidden and " lp-step" or " lp-round-note")
      .. '" data-poll="' .. html_escape(id) .. '" data-round="' .. r .. '">Round ' .. r
      .. ": discuss with your neighbour, then vote again</p>"
  end
  return table.concat(out, "\n")
end

local function poll_html(id)
  local poll = polls[id]
  local out = {}
  out[#out + 1] = timer_html(id, true)
  if poll.show_question then out[#out + 1] = question_html(id) end
  local hint = choices_hint(poll)
  if hint then out[#out + 1] = '<p class="poll-hint">' .. hint .. "</p>" end
  out[#out + 1] = '<div class="poll" data-poll="' .. html_escape(id) .. '">'
  for _, opt in ipairs(poll.options) do
    out[#out + 1] = '<button data-value="'
      .. html_escape(opt.value)
      .. '">'
      .. html_escape(opt.label)
      .. "</button>"
  end
  out[#out + 1] = "</div>"
  -- outside the .poll: poll.js takes every button inside one for an option
  if hint then
    out[#out + 1] = '<button type="button" class="poll-submit" data-poll="' .. html_escape(id) .. '" disabled>Submit</button>'
  end
  out[#out + 1] = '<p class="poll-voters">Responses: <span class="voters" data-poll="'
    .. html_escape(id)
    .. '">0</span></p>'
  out[#out + 1] = round_steps(id, poll, false)
  return table.concat(out, "\n")
end

-- "Correct answer: X", or "Correct answers: X, Y".
local function answer_text(poll, label_of)
  local labels = {}
  for _, opt in ipairs(poll.options) do
    if is_correct(poll.correct, opt.value) then labels[#labels + 1] = label_of(opt) end
  end
  if #labels == 0 then return nil end
  return (#labels > 1 and "Correct answers: " or "Correct answer: "), labels
end

------------------------------------------------------------ chart styling

-- A long label as lines, which Chart.js draws one under the other; a label
-- that fits stays a plain string.
local function wrap_label(text, width)
  local lines, line = {}, ""
  for word in text:gmatch("%S+") do
    if line ~= "" and utf8.len(line .. " " .. word) > width then
      lines[#lines + 1] = line
      line = word
    else
      line = line == "" and word or (line .. " " .. word)
    end
  end
  if line ~= "" then lines[#lines + 1] = line end
  return #lines > 1 and lines or text
end

local LEGEND_POSITIONS = { top = true, bottom = true, left = true, right = true }

-- The styling asked for on one .poll-results div, over the deck's defaults.
-- Sizes are px (a trailing "px" is allowed); anything unusable is a warning
-- and the setting is left out.
local function chart_settings(attrs, where)
  -- A setting comes from the div, else the deck's `chart:`. A value that will
  -- not do is a warning, and the next source is tried, so a typo on one chart
  -- falls back to the deck's choice rather than to the extension's.
  local function first(key, parse)
    for _, source in ipairs({ { attrs[key], where }, { chart_defaults[key], "livepoll: chart:" } }) do
      local v, from = source[1], source[2]
      if v ~= nil then
        local ok, value, problem = parse(tostring(v))
        if ok then return value end
        quarto.log.warning("livepoll: " .. from .. ": " .. key .. "=\"" .. tostring(v) .. "\" " .. problem .. "; ignored.")
      end
    end
    return nil
  end
  local function size(key)
    return first(key, function(v)
      local n = tonumber((v:gsub("%s*px$", "")))
      if n and n > 0 then return true, n end
      return false, nil, "should be a size in px"
    end)
  end
  local legend = first("legend", function(v)
    v = v:lower()
    if v == "false" or v == "no" or v == "none" then return true, false end
    if v == "true" or v == "yes" then return true, true end
    if LEGEND_POSITIONS[v] then return true, v end
    return false, nil, "should be top, bottom, left, right or false"
  end)
  local function text(key)
    return first(key, function(v) return true, v end)
  end
  return {
    font = size("font-size"),
    x = size("x-tick-size"),
    y = size("y-tick-size"),
    legend_size = size("legend-size"),
    legend = legend,
    color = text("color"),
    grid = text("grid-color"),
    wrap = size("label-wrap"),
  }
end

-- Apply settings to a chart's options. `base` is the chart type's own
-- defaults: { font = px or nil, legend = false or a position }. Nothing is
-- set that neither asked for, so an unstyled chart keeps the extension's
-- chart defaults (_extension.yml).
local function style_chart(options, st, base)
  -- Tables are only created for settings in use: the JSON encoder writes an
  -- empty Lua table as [], which Chart.js would take for an array of options.
  local tick = { x = st.x or st.font or base.font, y = st.y or st.font or base.font }
  for _, axis in ipairs({ "x", "y" }) do
    if tick[axis] or st.color or st.grid then
      local scale = options.scales[axis] or {}
      options.scales[axis] = scale
      if tick[axis] or st.color then scale.ticks = scale.ticks or {} end
      if tick[axis] then scale.ticks.font = { size = tick[axis] } end
      if st.color then scale.ticks.color = st.color end
      if st.grid then scale.grid = { color = st.grid } end
    end
  end

  local position = base.legend
  if st.legend == false then
    position = false
  elseif st.legend == true then
    position = position or "top"
  elseif st.legend then
    position = st.legend
  end
  local legend = { display = position ~= false }
  if position then legend.position = position end
  local legend_size = st.legend_size or st.font or base.font
  local labels = {}
  if legend_size then
    labels.font = { size = legend_size }
    labels.boxWidth = legend_size
    labels.padding = 12
  end
  if st.color then labels.color = st.color end
  if next(labels) then legend.labels = labels end
  options.plugins = options.plugins or {}
  options.plugins.legend = legend
end

local function results_html(id, orientation, height, show_question, st)
  local poll = polls[id]
  local labels, zeros = {}, {}
  for _, opt in ipairs(poll.options) do
    table.insert(labels, opt.label)
    table.insert(zeros, "0")
  end

  if st.wrap then
    for i, label in ipairs(labels) do labels[i] = wrap_label(label, st.wrap) end
  end

  local horizontal = orientation ~= "vertical"
  local value_axis = horizontal and "x" or "y"
  local chart = {
    data = {
      labels = labels,
      datasets = { { backgroundColor = "white", borderColor = "black", borderWidth = 2 } },
    },
    options = {
      indexAxis = horizontal and "y" or "x",
      plugins = { legend = { display = false } },
      scales = { [value_axis] = { beginAtZero = true, ticks = { precision = 0 } } },
      -- Chart.js does not size itself here. Its resize observer measures a
      -- container that reveal is still transforming mid-transition, so it grew
      -- the canvas and then snapped it back, over and over. livepoll.js sets
      -- the size once per slide, in slide coordinates.
      responsive = false,
      maintainAspectRatio = false,
    },
  }
  -- A poll chart is one unnamed set of bars: a legend would be an empty
  -- swatch, so it stays off (chart_settings warned if one was asked for).
  st.legend = false
  style_chart(chart.options, st, { legend = false })

  local out = {}
  if show_question then out[#out + 1] = question_html(id) end
  local chart_blocks = {
    '<div class="poll-results" style="position:relative;height:' .. height .. ';width:100%;">',
    '<canvas data-chart="bar" data-poll="'
      .. html_escape(id)
      .. '" width="900" height="'
      .. tostring(tonumber(height:match("%d+")) or 360)
      .. '">',
    ", " .. table.concat(zeros, ", "),
    "<!--",
    quarto.json.encode(chart),
    "-->",
    "</canvas>",
    "</div>",
  }
  for _, line in ipairs(chart_blocks) do
    out[#out + 1] = line
  end

  -- The same live count that sits beside the buttons. It belongs here too: the
  -- results slide is the one on screen while people are voting, and the number
  -- is the record of who took part — poll.js keeps every `.voters` span for the
  -- poll in step, whichever slide it is on.
  out[#out + 1] = '<p class="poll-voters">Responses: <span class="voters" data-poll="'
    .. html_escape(id)
    .. '">0</span></p>'

  if poll.correct then
    local prefix, labels = answer_text(poll, function(opt) return opt.label end)
    if labels then
      local strong = {}
      for i, l in ipairs(labels) do strong[i] = "<strong>" .. html_escape(l) .. "</strong>" end
      out[#out + 1] = '<p class="poll-answer fragment" data-poll="'
        .. html_escape(id)
        .. '" data-correct="'
        .. html_escape(correct_attr(poll.correct))
        .. '">' .. prefix
        .. table.concat(strong, ", ")
        .. "</p>"
    else
      quarto.log.warning(
        "livepoll: poll '" .. id .. "' marks '" .. correct_attr(poll.correct) .. "' correct, but no option has that value."
      )
    end
  end

  return table.concat(out, "\n")
end

local function cloud_html(id, height)
  local cloud = clouds[id]
  local out = { timer_html(id, true) }
  if cloud.show_question then out[#out + 1] = question_html(id, cloud.question) end
  out[#out + 1] = '<div class="wordcloud" data-wordcloud="'
    .. html_escape(id)
    .. '" style="position:relative;height:'
    .. height
    .. ';width:100%;">'
  out[#out + 1] = '<p class="wordcloud-empty" data-wordcloud="'
    .. html_escape(id)
    .. '">Waiting for words…</p>'
  out[#out + 1] = "</div>"
  out[#out + 1] = '<p class="poll-voters">Words: <span class="word-count" data-wordcloud="'
    .. html_escape(id)
    .. '">0</span></p>'
  return table.concat(out, "\n")
end

-------------------------------------------------------------- panel layout

local function is_panel(item)
  return (item.layout or default_layout) == "panel"
end

-- The panel layout shows options as written, like the bar rows it borrows
-- from; the A/B/C values stay underneath. letters="true" puts them back.
local function option_label(poll, opt)
  -- raw-HTML polls (the old <div class="poll"> syntax) have no `text`
  if is_panel(poll) and poll.letters ~= true and opt.text then return opt.text end
  return opt.label
end

-- The right-hand column: QR, URL, live count. The QR and URL are filled in by
-- livepoll.js, because the URL depends on where the deck is served from.
-- `count` is the counter span, which carries the class the plugins already keep
-- in step (`.voters` for polls, `.word-count` for clouds).
local function panel_side_html(show_qr, count, label, id)
  local out = { '<div class="lp-side">' }
  if show_qr then
    out[#out + 1] = '<div class="lp-qr"></div>'
    out[#out + 1] = '<div class="lp-url"></div>'
  end
  if id then out[#out + 1] = timer_html(id, false) end
  out[#out + 1] = '<div class="lp-count">' .. count
    .. '<span class="lp-count-label">' .. label .. "</span></div>"
  -- LIVE / CLOSED / OFFLINE and the room size, kept in step by livepoll.js
  out[#out + 1] = '<div class="lp-meta"><span class="lp-pill" data-state="offline">OFFLINE</span>'
    .. '<span class="lp-joined"></span></div>'
  out[#out + 1] = "</div>"
  return table.concat(out, "\n")
end

-- One slide that both asks and shows. The `.poll[data-poll]` wrapper and its
-- `button[data-value]` children are kept on purpose: poll.js counts votes
-- against those buttons, the control panel finds polls by them, and session.js
-- reads the options from them. Each button is simply drawn as a bar row.
local function panel_poll_html(id)
  local poll = polls[id]
  local eid = html_escape(id)
  local out = {
    '<div class="livepoll-question lp-poll" data-poll="' .. eid
      .. '" data-results="' .. poll.results .. '"'
      .. (poll.max_choices ~= nil and ' data-multi="true"' or "") .. ">",
    '<div class="lp-main">',
  }
  if poll.show_question then out[#out + 1] = question_html(id) end
  local hint = choices_hint(poll)
  if hint or (poll.rounds or 1) > 1 then
    out[#out + 1] = '<div class="lp-subhead">'
      .. (hint and ('<span class="lp-hint">' .. hint .. "</span>") or "")
      .. '<span class="lp-round-badge"></span></div>'
  end
  out[#out + 1] = '<div class="poll lp-bars" data-poll="' .. eid .. '">'
  for _, opt in ipairs(poll.options) do
    local label = html_escape(option_label(poll, opt))
    out[#out + 1] = '<button class="lp-row" data-value="' .. html_escape(opt.value)
      .. '" data-label="' .. label .. '">'
      .. '<span class="lp-label">' .. label .. "</span>"
      .. '<span class="lp-track"><span class="lp-fill"></span></span>'
      .. '<span class="lp-stat"><span class="lp-n">0</span><span class="lp-pct">0%</span></span>'
      .. "</button>"
  end
  out[#out + 1] = '<div class="lp-veil">Results hidden</div>'
  out[#out + 1] = "</div>"
  out[#out + 1] = "</div>"
  out[#out + 1] = panel_side_html(
    poll.qr,
    '<span class="voters lp-count-n" data-poll="' .. eid .. '">0</span>',
    "responses",
    id
  )

  -- the rounds come before the answer: vote, discuss, vote again, then hear it
  out[#out + 1] = round_steps(id, poll, true)

  -- The answer is the same `.poll-answer` fragment the classic results slide
  -- uses, so the reveal, the late-joiner relay and the phones all work as
  -- before. Here it is only a step: the row turning green is the visible part.
  local prefix, answers = nil, nil
  if poll.correct then
    prefix, answers = answer_text(poll, function(opt) return option_label(poll, opt) end)
    if not answers then
      quarto.log.warning(
        "livepoll: poll '" .. id .. "' marks '" .. correct_attr(poll.correct) .. "' correct, but no option has that value."
      )
    end
  end
  if answers then
    out[#out + 1] = '<p class="poll-answer fragment lp-step" data-poll="' .. eid
      .. '" data-correct="' .. html_escape(correct_attr(poll.correct)) .. '">' .. prefix
      .. html_escape(table.concat(answers, ", ")) .. "</p>"
  elseif poll.results == "hidden" then
    -- nothing to reveal but the results themselves
    out[#out + 1] = '<p class="lp-reveal fragment lp-step" data-poll="' .. eid .. '">Results</p>'
  end

  out[#out + 1] = "</div>"
  return table.concat(out, "\n")
end

local function panel_cloud_html(id)
  local cloud = clouds[id]
  local eid = html_escape(id)
  local out = {
    '<div class="livepoll-question lp-wordcloud" data-wordcloud="' .. eid .. '">',
    '<div class="lp-main">',
  }
  if cloud.show_question then out[#out + 1] = question_html(id, cloud.question) end
  out[#out + 1] = '<div class="wordcloud lp-cloud" data-wordcloud="' .. eid .. '">'
  out[#out + 1] = '<p class="wordcloud-empty" data-wordcloud="' .. eid .. '">Waiting for words…</p>'
  out[#out + 1] = "</div>"
  out[#out + 1] = "</div>"
  out[#out + 1] = panel_side_html(
    cloud.qr,
    '<span class="word-count lp-count-n" data-wordcloud="' .. eid .. '">0</span>',
    "words",
    id
  )
  out[#out + 1] = "</div>"
  return table.concat(out, "\n")
end

------------------------------------------------------------ likert markup

-- classic: the question slide is the voting slide, as for a poll. Each
-- statement gets a row of buttons, one per point, and a Submit button sends the
-- lot (livepoll.js, initClassicLikerts). Deliberately not inside a `.poll`:
-- poll.js claims every `.poll` element's buttons as poll votes.
local function likert_html(id)
  local likert = likerts[id]
  local eid = html_escape(id)
  local out = { timer_html(id, true) }
  if likert.show_question then out[#out + 1] = question_html(id, likert.question) end
  out[#out + 1] = '<div class="likert lp-likert-classic' .. (likert.numeric and " likert-numeric" or "")
    .. '" data-likert="' .. eid .. '" style="--lp-points:' .. #likert.labels .. '">'
  for s, statement in ipairs(likert.statements) do
    out[#out + 1] = '<div class="likert-statement">'
    if not likert.single then
      out[#out + 1] = '<div class="likert-statement-text">' .. html_escape(statement) .. "</div>"
    end
    out[#out + 1] = '<div class="likert-choices">'
    for p, label in ipairs(likert.labels) do
      out[#out + 1] = '<button type="button" class="likert-choice" data-s="' .. (s - 1)
        .. '" data-p="' .. (p - 1) .. '">' .. html_escape(label) .. "</button>"
    end
    out[#out + 1] = "</div>"
    if likert.anchors then
      out[#out + 1] = '<div class="likert-anchors"><span>' .. html_escape(likert.anchors[1])
        .. "</span><span>" .. html_escape(likert.anchors[2]) .. "</span></div>"
    end
    out[#out + 1] = "</div>"
  end
  out[#out + 1] = '<button type="button" class="likert-submit" disabled>Submit</button>'
  out[#out + 1] = "</div>"
  out[#out + 1] = '<p class="poll-voters">Responses: <span class="likert-voters" data-likert="'
    .. eid .. '">0</span></p>'
  return table.concat(out, "\n")
end

local LIKERT_NEG = { "#f8cfc4", "#f09a84", "#dc5a3c", "#b23f27", "#842a1a" }
local LIKERT_POS = { "#c6dcf8", "#86b6ef", "#3987e5", "#1f63b8", "#104281" }
local LIKERT_MID = "#dcdbd6"

-- One colour per point: the diverging palette for a worded scale, light to
-- dark blue for a numeric one.
local function likert_colours(likert)
  local n = #likert.labels
  local out = {}
  if likert.numeric then
    local a, b = { 0xc6, 0xdc, 0xf8 }, { 0x10, 0x42, 0x81 }
    for i = 0, n - 1 do
      local t = n > 1 and i / (n - 1) or 0
      out[#out + 1] = string.format("#%02x%02x%02x",
        math.floor(a[1] + (b[1] - a[1]) * t + 0.5),
        math.floor(a[2] + (b[2] - a[2]) * t + 0.5),
        math.floor(a[3] + (b[3] - a[3]) * t + 0.5))
    end
  else
    for _, tone in ipairs(likert_tones(n)) do
      if tone.side == "mid" then out[#out + 1] = LIKERT_MID
      elseif tone.side == "neg" then out[#out + 1] = LIKERT_NEG[tone.step]
      else out[#out + 1] = LIKERT_POS[tone.step] end
    end
  end
  return out
end

-- classic results: one stacked bar per statement, one segment per point. The
-- dataset labels go through the chart plugin's CSV, which splits on commas.
-- Text sizes for this chart, in px. The extension's chart default (30, set in
-- _extension.yml for poll bars) is far too big for statements and a legend of
-- five to eleven points: Chart.js then drops statement labels it cannot fit.
local LIKERT_CHART_FONT = 16

local function likert_results_html(id, height, show_question, orientation, st)
  local likert = likerts[id]
  local eid = html_escape(id)
  local colours = likert_colours(likert)
  local datasets, rows = {}, {}
  for p, label in ipairs(likert.labels) do
    datasets[#datasets + 1] = { backgroundColor = colours[p], borderWidth = 0 }
    local zeros = {}
    for _ = 1, #likert.statements do zeros[#zeros + 1] = "0" end
    rows[#rows + 1] = label:gsub(",", ";") .. ", " .. table.concat(zeros, ", ")
  end
  -- horizontal (default): a bar per statement, statements down the left.
  -- vertical: a column per statement, statements along the bottom, wrapped
  -- narrower since they share the width.
  local vertical = orientation == "vertical"
  local labels = {}
  for i, statement in ipairs(likert.statements) do
    -- Chart.js draws an array label as lines; unwrapped, a long statement
    -- is cut off at the chart's edge
    labels[i] = wrap_label(statement, st.wrap or (vertical and 18 or 30))
  end
  -- every statement labelled (autoSkip off), the counts never slanted
  local category = { stacked = true, ticks = { autoSkip = false, maxRotation = 0 } }
  local value = { stacked = true, beginAtZero = true, ticks = { precision = 0, maxRotation = 0 } }
  local chart = {
    data = { labels = labels, datasets = datasets },
    options = {
      indexAxis = vertical and "x" or "y",
      scales = vertical and { x = category, y = value } or { x = value, y = category },
      responsive = false, -- sized by livepoll.js, as for polls
      maintainAspectRatio = false,
    },
  }
  style_chart(chart.options, st, { font = LIKERT_CHART_FONT, legend = "bottom" })
  local out = {}
  if show_question then out[#out + 1] = question_html(id, likert.question) end
  out[#out + 1] = '<div class="poll-results" style="position:relative;height:' .. height .. ';width:100%;">'
  out[#out + 1] = '<canvas data-chart="bar" data-likert="' .. eid .. '" width="900" height="'
    .. tostring(tonumber(height:match("%d+")) or 360) .. '">'
  out[#out + 1] = table.concat(rows, "\n")
  out[#out + 1] = "<!--"
  out[#out + 1] = quarto.json.encode(chart)
  out[#out + 1] = "-->"
  out[#out + 1] = "</canvas>"
  out[#out + 1] = "</div>"
  out[#out + 1] = '<p class="poll-voters">Responses: <span class="likert-voters" data-likert="'
    .. eid .. '">0</span></p>'
  return table.concat(out, "\n")
end

-- embedded: the chart is drawn here once, empty; livepoll.js only moves bars.
-- Worded scales get one diverging bar per statement (disagree left of the
-- line, agree right), numeric ones a histogram per statement with the mean.
local function panel_likert_html(id)
  local likert = likerts[id]
  local eid = html_escape(id)
  local n = #likert.labels
  local out = {
    '<div class="livepoll-question lp-likert-q" data-likert="' .. eid
      .. '" data-results="' .. likert.results .. '">',
    '<div class="lp-main">',
  }
  if likert.show_question then out[#out + 1] = question_html(id, likert.question) end

  local kind = likert.numeric and "lp-lk-numeric" or "lp-lk-labeled"
  out[#out + 1] = '<div class="likert lp-likert ' .. kind .. (n <= 3 and " lp-lk-short" or "")
    .. '" data-likert="' .. eid .. '" data-statements="' .. #likert.statements
    .. '" style="--lp-points:' .. n .. '">'

  -- legend
  if likert.numeric then
    local a = likert.anchors
    out[#out + 1] = '<div class="lp-lk-legend lp-lk-anchors">'
    if a and a[1] ~= "" then
      out[#out + 1] = '<span class="lp-lk-anchor"><b>' .. html_escape(likert.labels[1]) .. "</b> " .. html_escape(a[1]) .. "</span>"
    end
    if a and (a[1] ~= "" or a[2] ~= "") then out[#out + 1] = '<span class="lp-lk-dash"></span>' end
    if a and a[2] ~= "" then
      out[#out + 1] = '<span class="lp-lk-anchor"><b>' .. html_escape(likert.labels[n]) .. "</b> " .. html_escape(a[2]) .. "</span>"
    end
    out[#out + 1] = '<span class="lp-lk-key lp-lk-mean-key"><i class="lp-lk-mean-icon"></i>mean</span>'
    out[#out + 1] = "</div>"
  else
    local tones = likert_tones(n)
    out[#out + 1] = '<div class="lp-lk-legend">'
    for p, label in ipairs(likert.labels) do
      out[#out + 1] = '<span class="lp-lk-key"><i class="lp-lk-swatch" data-side="' .. tones[p].side
        .. '" data-step="' .. tones[p].step .. '"></i>' .. html_escape(label) .. "</span>"
    end
    out[#out + 1] = "</div>"
  end

  -- one row per statement
  out[#out + 1] = '<div class="lp-lk-rows">'
  for _, statement in ipairs(likert.statements) do
    local label = likert.single and "" or ('<div class="lp-lk-label">' .. html_escape(statement) .. "</div>")
    out[#out + 1] = '<div class="lp-lk-row">'
    if likert.numeric then
      out[#out + 1] = '<div class="lp-lk-head">' .. label
        .. '<span class="lp-lk-meta"><span class="lp-lk-stats"></span><span class="lp-lk-n"></span></span></div>'
      out[#out + 1] = '<div class="lp-hist">'
      for _ = 1, n do
        out[#out + 1] = '<div class="lp-hist-col"><div class="lp-hist-bar"><span class="lp-hist-n"></span></div></div>'
      end
      out[#out + 1] = '<div class="lp-hist-mean" hidden></div></div>'
      out[#out + 1] = '<div class="lp-hist-axis">'
      for _, l in ipairs(likert.labels) do out[#out + 1] = "<span>" .. html_escape(l) .. "</span>" end
      out[#out + 1] = "</div>"
    else
      local tones = likert_tones(n)
      out[#out + 1] = '<div class="lp-lk-head">' .. label .. '<span class="lp-lk-n"></span></div>'
      out[#out + 1] = '<div class="lp-lk-line"><span class="lp-lk-total lp-lk-neg"></span><div class="lp-lk-track"><div class="lp-lk-axis"></div>'
      for p, l in ipairs(likert.labels) do
        out[#out + 1] = '<div class="lp-lk-seg lp-lk-zero" data-side="' .. tones[p].side .. '" data-step="' .. tones[p].step
          .. '" title="' .. html_escape(l) .. '"><span class="lp-lk-pct"></span></div>'
      end
      out[#out + 1] = '</div><span class="lp-lk-total lp-lk-pos"></span></div>'
    end
    out[#out + 1] = "</div>"
  end
  out[#out + 1] = "</div>"
  out[#out + 1] = '<div class="lp-veil">Results hidden</div>'
  out[#out + 1] = "</div>"
  out[#out + 1] = "</div>"

  out[#out + 1] = panel_side_html(
    likert.qr,
    '<span class="likert-voters lp-count-n" data-likert="' .. eid .. '">0</span>',
    "responses",
    id
  )
  if likert.results == "hidden" then
    out[#out + 1] = '<p class="lp-reveal fragment lp-step" data-likert="' .. eid .. '">Results</p>'
  end
  out[#out + 1] = "</div>"
  return table.concat(out, "\n")
end

------------------------------------------- estimate, rank, hotspot markup

-- The answer step for the kinds that have one: the same `.poll-answer`
-- fragment polls use, so revealing it, telling late joiners and scoring all
-- work the one way. `results="hidden"` without an answer gets the results step.
local function answer_step(id, item, correct, text)
  local eid = html_escape(id)
  if correct ~= nil then
    return '<p class="poll-answer fragment lp-step" data-poll="' .. eid .. '" data-correct="'
      .. html_escape(correct) .. '">' .. html_escape(text) .. "</p>"
  elseif item.results == "hidden" then
    return '<p class="lp-reveal fragment lp-step" data-poll="' .. eid .. '">Results</p>'
  end
  return ""
end

local function number_text(n)
  if n == nil then return nil end
  if n == math.floor(n) then return string.format("%d", n) end
  return tostring(n)
end

-- `side`: false for a .poll-results slide, which has no QR column.
local function estimate_html(id, side)
  local e = estimates[id]
  local eid = html_escape(id)
  local out = {
    '<div class="livepoll-question lp-estimate-q' .. (side and "" or " lp-noside") .. '" data-estimate="' .. eid
      .. '" data-results="' .. e.results .. '">',
    '<div class="lp-main">',
  }
  if e.show_question or not side then out[#out + 1] = question_html(id, e.question) end
  out[#out + 1] = '<div class="lp-estimate" data-estimate="' .. eid .. '">'
  out[#out + 1] = '<div class="lp-est-plot"><div class="lp-est-bars"></div>'
    .. '<div class="lp-est-line lp-est-median" hidden><span></span></div>'
    .. '<div class="lp-est-line lp-est-answer" hidden><span></span></div></div>'
  out[#out + 1] = '<div class="lp-est-axis"></div>'
  out[#out + 1] = '<div class="lp-est-summary"></div>'
  out[#out + 1] = '<p class="lp-empty">Waiting for answers…</p>'
  out[#out + 1] = "</div>"
  out[#out + 1] = '<div class="lp-veil">Results hidden</div>'
  out[#out + 1] = "</div>"
  if side then
    out[#out + 1] = panel_side_html(e.qr,
      '<span class="estimate-voters lp-count-n" data-estimate="' .. eid .. '">0</span>', "answers", id)
  end
  local text = e.answer and ("Answer: " .. number_text(e.answer) .. (e.unit and (" " .. e.unit) or "")) or nil
  out[#out + 1] = answer_step(id, e, e.answer and number_text(e.answer) or nil, text)
  out[#out + 1] = "</div>"
  return table.concat(out, "\n")
end

local function rank_html(id, side)
  local r = ranks[id]
  local eid = html_escape(id)
  local out = {
    '<div class="livepoll-question lp-rank-q' .. (side and "" or " lp-noside") .. '" data-rank="' .. eid
      .. '" data-results="' .. r.results .. '">',
    '<div class="lp-main">',
  }
  if r.show_question or not side then out[#out + 1] = question_html(id, r.question) end
  if r.top < #r.items then
    out[#out + 1] = '<div class="lp-subhead"><span class="lp-hint">Top ' .. r.top .. " of " .. #r.items .. "</span></div>"
  end
  out[#out + 1] = '<div class="lp-rank" data-rank="' .. eid .. '" style="--lp-items:' .. #r.items .. '">'
  for i, item in ipairs(r.items) do
    out[#out + 1] = '<div class="lp-rank-row" data-item="' .. (i - 1) .. '" style="--lp-place:' .. (i - 1) .. '">'
      .. '<span class="lp-rank-pos"></span>'
      .. '<span class="lp-rank-label">' .. html_escape(item) .. "</span>"
      .. '<span class="lp-track"><span class="lp-fill"></span></span>'
      .. '<span class="lp-rank-stat"></span></div>'
  end
  out[#out + 1] = "</div>"
  out[#out + 1] = '<div class="lp-veil">Results hidden</div>'
  out[#out + 1] = "</div>"
  if side then
    out[#out + 1] = panel_side_html(r.qr,
      '<span class="rank-voters lp-count-n" data-rank="' .. eid .. '">0</span>', "responses", id)
  end
  out[#out + 1] = answer_step(id, r, nil, nil)
  out[#out + 1] = "</div>"
  return table.concat(out, "\n")
end

local function hotspot_html(id, side)
  local h = hotspots[id]
  local eid = html_escape(id)
  local out = {
    '<div class="livepoll-question lp-hotspot-q' .. (side and "" or " lp-noside") .. '" data-hotspot="' .. eid
      .. '" data-results="' .. h.results .. '">',
    '<div class="lp-main">',
  }
  if h.show_question or not side then out[#out + 1] = question_html(id, h.question) end
  out[#out + 1] = '<div class="lp-hotspot" data-hotspot="' .. eid .. '"><div class="lp-hot-frame">'
    .. '<img class="lp-hot-img" src="' .. html_escape(h.image) .. '" alt="' .. html_escape(h.alt or "") .. '">'
    .. '<canvas class="lp-hot-heat"></canvas><svg class="lp-hot-marks" preserveAspectRatio="none"></svg>'
    .. "</div></div>"
  out[#out + 1] = '<div class="lp-veil">Results hidden</div>'
  out[#out + 1] = "</div>"
  if side then
    out[#out + 1] = panel_side_html(h.qr,
      '<span class="hotspot-voters lp-count-n" data-hotspot="' .. eid .. '">0</span>', "taps", id)
  end
  local correct = nil
  if h.answer then correct = table.concat({ h.answer[1], h.answer[2], h.answer[3] }, ",") end
  out[#out + 1] = answer_step(id, h, correct, correct and "The answer" or nil)
  out[#out + 1] = "</div>"
  return table.concat(out, "\n")
end

-- The audience's questions, most upvoted first (qa.js). max="6" shows that
-- many; qr="false" drops the side column's QR.
local function qa_html(el)
  local max = tonumber(el.attributes["max"] or "6") or 6
  local title = el.attributes["title"]
  local out = {
    '<div class="livepoll-question lp-qa-q" data-qa="board" data-max="' .. max .. '">',
    '<div class="lp-main">',
  }
  if title then out[#out + 1] = '<h3 class="poll-question">' .. html_escape(title) .. "</h3>" end
  out[#out + 1] = '<ol class="lp-qa-list"></ol>'
  out[#out + 1] = '<p class="lp-empty">No questions yet. Ask one on the poll page.</p>'
  out[#out + 1] = "</div>"
  out[#out + 1] = panel_side_html(truthy(el.attributes["qr"]) ~= false,
    '<span class="qa-count lp-count-n">0</span>', "questions", nil)
  out[#out + 1] = "</div>"
  return table.concat(out, "\n")
end

-- The quiz scores so far (quiz.js). top="10" shows that many.
local function leaderboard_html(el)
  local top = tonumber(el.attributes["top"] or "10") or 10
  local title = el.attributes["title"]
  local out = {
    '<div class="livepoll-question lp-leader-q lp-noside" data-leaderboard="' .. top .. '">',
    '<div class="lp-main">',
  }
  if title then out[#out + 1] = '<h3 class="poll-question">' .. html_escape(title) .. "</h3>" end
  out[#out + 1] = '<ol class="lp-leaderboard"></ol>'
  out[#out + 1] = '<p class="lp-empty">No scores yet.</p>'
  out[#out + 1] = "</div></div>"
  return table.concat(out, "\n")
end

local function generate_div(el)
  if el.classes:includes("estimate") and estimates[el.identifier] then
    return pandoc.RawBlock("html", estimate_html(el.identifier, true))
  end
  if el.classes:includes("rank") and ranks[el.identifier] then
    return pandoc.RawBlock("html", rank_html(el.identifier, true))
  end
  if el.classes:includes("hotspot") and hotspots[el.identifier] then
    return pandoc.RawBlock("html", hotspot_html(el.identifier, true))
  end
  if el.classes:includes("qa") then
    qa_boards = qa_boards + 1
    return pandoc.RawBlock("html", qa_html(el))
  end
  if el.classes:includes("leaderboard") then
    leaderboards = leaderboards + 1
    return pandoc.RawBlock("html", leaderboard_html(el))
  end

  if el.classes:includes("likert") then
    local id = el.identifier
    if not likerts[id] then return nil end
    if is_panel(likerts[id]) then
      return pandoc.RawBlock("html", panel_likert_html(id))
    end
    return pandoc.RawBlock("html", likert_html(id))
  end

  if el.classes:includes("wordcloud") then
    local id = el.identifier
    if id == nil or id == "" then
      generate_seq = generate_seq + 1
      id = "cloud-" .. generate_seq
    end
    if not clouds[id] then return nil end
    if is_panel(clouds[id]) then
      return pandoc.RawBlock("html", panel_cloud_html(id))
    end
    return pandoc.RawBlock("html", cloud_html(id, el.attributes["height"] or "360px"))
  end

  if el.classes:includes("poll") then
    local id = el.identifier
    if id == nil or id == "" then
      generate_seq = generate_seq + 1
      id = "poll-" .. generate_seq
    end
    if not polls[id] then return nil end
    if is_panel(polls[id]) then
      return pandoc.RawBlock("html", panel_poll_html(id))
    end
    return pandoc.RawBlock("html", poll_html(id))
  end

  if el.classes:includes("poll-results") then
    local id = el.attributes["for"] or el.identifier
    if id == nil or id == "" then
      quarto.log.warning("livepoll: a .poll-results div has no for=\"<poll id>\".")
      return nil
    end
    if estimates[id] then return pandoc.RawBlock("html", estimate_html(id, false)) end
    if ranks[id] then return pandoc.RawBlock("html", rank_html(id, false)) end
    if hotspots[id] then return pandoc.RawBlock("html", hotspot_html(id, false)) end
    if likerts[id] then
      local orientation = el.attributes["orientation"]
      if orientation ~= nil and orientation ~= "horizontal" and orientation ~= "vertical" then
        quarto.log.warning("livepoll: .poll-results for '" .. id .. "': orientation should be horizontal or vertical, got '"
          .. orientation .. "'; using horizontal.")
        orientation = nil
      end
      return pandoc.RawBlock("html", likert_results_html(
        id,
        el.attributes["height"] or "360px",
        truthy(el.attributes["show-question"]) == true,
        orientation,
        chart_settings(el.attributes, ".poll-results for '" .. id .. "'")
      ))
    end
    if not polls[id] then
      quarto.log.warning("livepoll: .poll-results refers to unknown poll '" .. id .. "'.")
      return nil
    end
    if el.attributes["legend"] or el.attributes["legend-size"] then
      quarto.log.warning("livepoll: .poll-results for '" .. id .. "': a poll chart has no legend "
        .. "(legend= and legend-size= are for rating scales); ignored.")
    end
    return pandoc.RawBlock(
      "html",
      results_html(
        id,
        el.attributes["orientation"],
        el.attributes["height"] or "360px",
        truthy(el.attributes["show-question"]) == true,
        chart_settings(el.attributes, ".poll-results for '" .. id .. "'")
      )
    )
  end

  if el.classes:includes("poll-qr") then
    local attrs = { 'class="livepoll-qr"' }
    if el.attributes["url"] then
      attrs[#attrs + 1] = 'data-url="' .. html_escape(el.attributes["url"]) .. '"'
    end
    if el.attributes["size"] then
      attrs[#attrs + 1] = 'data-size="' .. html_escape(el.attributes["size"]) .. '"'
    end
    if truthy(el.attributes["caption"]) == false then
      attrs[#attrs + 1] = 'data-caption="false"'
    end
    return pandoc.RawBlock("html", "<div " .. table.concat(attrs, " ") .. "></div>")
  end

  return nil
end

--------------------------------------------------------- seminar config

-- A deck's own `seminar:` block REPLACES the project's; it does not merge into
-- it. So a week that sets nothing but the room
--
--     seminar:
--       room: "week-01"
--
-- leaves `meta.seminar` holding exactly that — the server, venue and hash in
-- _quarto.yml are not in it. The deck itself still works, because Quarto merges
-- the two maps properly on the way into the Reveal *plugin* config, which is
-- what seminar.js reads. Only this filter sees the unmerged version, and the
-- config block it writes is what poll.html configures itself from. The symptom
-- is therefore lopsided and confusing: hosting works, and the participant page
-- says "No deck found".
--
-- So: read the project's block ourselves and let the deck's values win over it,
-- which is the merge Quarto was assumed to be doing. Pandoc will parse a YAML
-- metadata block for us, so _quarto.yml can be handed over as one.
local function project_seminar()
  if not (quarto and quarto.project and quarto.project.directory) then
    return nil
  end

  local handle = io.open(quarto.project.directory .. "/_quarto.yml", "r")
  if not handle then
    return nil
  end
  local contents = handle:read("a")
  handle:close()

  -- Wrapped in --- so the whole file reads as one metadata block. pcall because
  -- a _quarto.yml is not required to be something Pandoc will parse, and a
  -- project that trips over this should lose the fallback, not the render.
  local ok, parsed = pcall(pandoc.read, "---\n" .. contents .. "\n---\n", "markdown")
  if not ok or not parsed then
    return nil
  end

  return parsed.meta.seminar
end

-- The deck's block, backfilled from the project's for anything it leaves out.
local function seminar_config(meta)
  local deck = meta.seminar
  local project = project_seminar()

  if project == nil then
    return deck
  end
  if deck == nil then
    return project
  end

  local merged = {}
  for key, value in pairs(project) do
    merged[key] = value
  end
  for key, value in pairs(deck) do
    merged[key] = value
  end
  return merged
end

------------------------------------------------------- recorded session

-- session.js (Alt+R) downloads session.json at the end of a class. Put it next
-- to the deck's .qmd and re-render, and the results it recorded are replayed on
-- the slides: livepoll.js feeds them through the same messages a live session
-- uses, so the bars, charts, counts and clouds all show what the room answered.
--
-- A deck rendered without the file comes out exactly as before, and a file
-- that cannot be read is a warning and no replay, never a failed render.
-- `livepoll: session: false` turns replay off; `session: other.json` reads
-- another file.

local function read_file(path)
  local handle = io.open(path, "rb")
  if not handle then return nil end
  local contents = handle:read("a")
  handle:close()
  return contents
end

-- Votes for one recorded poll, keyed by the deck's option values. session.js
-- writes options in button order, which is the deck's order, so position is
-- the match; labels are the fallback for a poll whose options have changed
-- since the class.
local function recorded_votes(id, poll, rec)
  local votes, total = {}, 0
  local rec_options = rec.options or {}
  if #rec_options == #poll.options then
    for i, opt in ipairs(poll.options) do
      local n = tonumber(rec_options[i].votes) or 0
      votes[opt.value] = n
      total = total + n
    end
  else
    for _, r in ipairs(rec_options) do
      local found = false
      for _, opt in ipairs(poll.options) do
        if r.label == opt.label or r.label == opt.text or r.label == option_label(poll, opt) then
          local n = tonumber(r.votes) or 0
          votes[opt.value] = n
          total = total + n
          found = true
        end
      end
      if not found then
        quarto.log.warning(
          "livepoll: session.json has an answer '" .. tostring(r.label) .. "' for poll '" .. id
            .. "' that the deck no longer offers; it is left out"
        )
      end
    end
    -- options added since the class start at zero
    for _, opt in ipairs(poll.options) do
      if votes[opt.value] == nil then votes[opt.value] = 0 end
    end
  end
  return votes, total
end

local function read_session(meta)
  local setting = meta.livepoll and meta.livepoll.session
  local name = "session.json"
  if setting ~= nil then
    local v = meta_value(setting)
    if v == false or truthy(v) == false then return nil end
    if type(v) == "string" and v ~= "" and v ~= "true" then name = v end
  end

  local dir = quarto.doc.input_file and pandoc.path.directory(quarto.doc.input_file) or "."
  local path = pandoc.path.join({ dir, name })
  local raw = read_file(path)
  if not raw then return nil end

  local ok, session = pcall(quarto.json.decode, raw)
  if not ok or type(session) ~= "table" then
    quarto.log.warning("livepoll: " .. name .. " is not readable JSON; no results replayed")
    return nil
  end
  if session.version ~= 1 then
    quarto.log.warning(
      "livepoll: " .. name .. " is version " .. tostring(session.version)
        .. "; only version 1 is understood, so no results replayed"
    )
    return nil
  end

  local recorded = { polls = {}, clouds = {}, likerts = {} }
  local any = false

  for _, rec in ipairs(session.polls or {}) do
    local poll = rec.id and polls[rec.id]
    if not poll then
      quarto.log.warning("livepoll: " .. name .. " has poll '" .. tostring(rec.id) .. "', which is not in this deck")
    else
      local votes, total = recorded_votes(rec.id, poll, rec)
      if total > 0 then
        recorded.polls[rec.id] = { votes = votes, voters = tonumber(rec.voters) or total }
        -- the rounds before the last, drawn beside it
        if type(rec.rounds) == "table" and #rec.rounds > 1 then
          local history = {}
          for i = 1, #rec.rounds - 1 do
            local round = rec.rounds[i]
            local v = recorded_votes(rec.id, poll, { options = round.options or {} })
            history[#history + 1] = { votes = v, voters = tonumber(round.voters) or 0 }
          end
          recorded.polls[rec.id].history = history
        end
        any = true
      end
    end
  end

  -- estimates, rankings and hotspots carry their raw answers; livepoll.js
  -- tallies them again
  local function raw(list, known, key, what)
    for _, rec in ipairs(list or {}) do
      if not (rec.id and known[rec.id]) then
        quarto.log.warning("livepoll: " .. name .. " has " .. what .. " '" .. tostring(rec.id) .. "', which is not in this deck")
      elseif type(rec.answers) == "table" and #rec.answers > 0 then
        recorded[key] = recorded[key] or {}
        recorded[key][rec.id] = rec.answers
        any = true
      end
    end
  end
  raw(session.estimates, estimates, "estimates", "estimate")
  raw(session.ranks, ranks, "ranks", "ranking")
  raw(session.hotspots, hotspots, "hotspots", "hotspot")

  if type(session.questions) == "table" and #session.questions > 0 then
    local list = {}
    for i, q in ipairs(session.questions) do
      if q.text and (q.status == "open" or q.status == "answered") then
        list[#list + 1] = { id = "q" .. i, text = q.text, votes = tonumber(q.votes) or 0, status = q.status, t = i }
      end
    end
    if #list > 0 then
      recorded.questions = list
      any = true
    end
  end

  if type(session.leaderboard) == "table" and #session.leaderboard > 0 then
    local board = {}
    for _, p in ipairs(session.leaderboard) do
      board[#board + 1] = { nick = tostring(p.nickname or ""), score = tonumber(p.score) or 0 }
    end
    recorded.leaderboard = board
    any = true
  end

  for _, rec in ipairs(session.clouds or {}) do
    if not (rec.id and clouds[rec.id]) then
      quarto.log.warning("livepoll: " .. name .. " has word cloud '" .. tostring(rec.id) .. "', which is not in this deck")
    else
      local counts, n = {}, 0
      for _, w in ipairs(rec.words or {}) do
        if w.word and (tonumber(w.count) or 0) > 0 then
          counts[w.word] = tonumber(w.count)
          n = n + 1
        end
      end
      if n > 0 then
        recorded.clouds[rec.id] = counts
        any = true
      end
    end
  end

  for _, rec in ipairs(session.likerts or {}) do
    local likert = rec.id and likerts[rec.id]
    if not likert then
      quarto.log.warning("livepoll: " .. name .. " has likert '" .. tostring(rec.id) .. "', which is not in this deck")
    else
      -- counts[statement][point]; only usable if the shape still matches
      local counts = rec.counts or {}
      local fits = #counts == #likert.statements
      for _, row in ipairs(counts) do
        if type(row) ~= "table" or #row ~= #likert.labels then fits = false end
      end
      if not fits then
        quarto.log.warning(
          "livepoll: " .. name .. " has likert '" .. rec.id .. "' with a different number of "
            .. "statements or scale points than the deck now has; it is not replayed"
        )
      elseif (tonumber(rec.voters) or 0) > 0 then
        recorded.likerts[rec.id] = { counts = counts, voters = tonumber(rec.voters) }
        any = true
      end
    end
  end

  if not any then return nil end
  -- an empty Lua table would encode as [] rather than {}
  if next(recorded.polls) == nil then recorded.polls = nil end
  if next(recorded.clouds) == nil then recorded.clouds = nil end
  if next(recorded.likerts) == nil then recorded.likerts = nil end
  return recorded
end

------------------------------------------------------------------ the emit

local function emit(doc)
  if not quarto.doc.is_format("revealjs") then return nil end

  local meta = doc.meta
  local seminar = seminar_config(meta)

  local position = "top-right"
  local auto_activate = true
  local in_menu = true
  if meta.livepoll then
    if meta.livepoll.position then
      local p = pandoc.utils.stringify(meta.livepoll.position)
      if POSITIONS[p] then
        position = p
      else
        quarto.log.warning("livepoll: unknown position '" .. p .. "', using top-right")
      end
    end
    local aa = meta.livepoll["auto-activate"]
    if aa ~= nil then auto_activate = truthy(meta_value(aa)) == true end
    -- `menu: false` keeps the controls in the floating panel instead of a
    -- "Live poll" tab in the reveal menu
    local m = meta.livepoll.menu
    if m ~= nil then in_menu = truthy(meta_value(m)) ~= false end
  end

  -- The features that run across the whole deck rather than on one slide.
  local function option(key, default)
    local v = meta.livepoll and meta.livepoll[key]
    if v == nil then return default end
    return meta_value(v)
  end
  local function switch(key, default)
    local v = option(key, nil)
    if v == nil then return default end
    return truthy(v) ~= false
  end

  -- qa: true (default) | false | moderated — moderated holds each question
  -- back until the presenter approves it
  local qa = option("qa", true)
  if qa ~= "moderated" then qa = truthy(qa) ~= false end
  if qa_boards > 0 and qa == false then
    quarto.log.warning("livepoll: the deck has a .qa slide but `livepoll: qa: false`; the board will stay empty.")
  end

  -- ids: session (default) | persistent | none — what session.json says about
  -- who gave each response (see README, "Privacy")
  local ids = option("ids", "session")
  if ids ~= "session" and ids ~= "persistent" and ids ~= "none" then
    quarto.log.warning("livepoll: `ids:` should be session, persistent or none; using session.")
    ids = "session"
  end

  local signal_window = tonumber(option("signal-window", "120")) or 120
  local quiz = switch("quiz", false)
  if leaderboards > 0 and not quiz then
    quarto.log.warning("livepoll: the deck has a .leaderboard slide but `livepoll: quiz:` is not on; it will stay empty.")
  end

  if seminar == nil then
    quarto.log.warning(
      "livepoll: no top-level `seminar:` block found. The deck will still "
        .. "render, but poll.html cannot configure itself from it."
    )
  else
    if meta_value(seminar.hash) == nil then
      quarto.log.warning("livepoll: `seminar.hash` is not set — hosting will fail.")
    end
    if meta_value(seminar.url) == nil then
      quarto.log.warning(
        "livepoll: `seminar.url` (the venue) is not set. It will fall back to "
          .. "the page host, which changes with the port on localhost."
      )
    end
  end

  if #poll_order == 0 and #cloud_order == 0 and #likert_order == 0 and #estimate_order == 0
    and #rank_order == 0 and #hotspot_order == 0 and qa_boards == 0 then
    quarto.log.warning("livepoll: no polls or word clouds found on the slides.")
  end

  -- publish only what the poll page needs; show_question is layout state
  local published_polls, published_clouds = {}, {}
  for id, poll in pairs(polls) do
    -- the phones show the same labels as the slide
    local options = {}
    for _, opt in ipairs(poll.options) do
      table.insert(options, { value = opt.value, label = option_label(poll, opt) })
    end
    published_polls[id] = {
      question = poll.question,
      options = options,
      correct = poll.correct,
      maxChoices = poll.max_choices,
      rounds = poll.rounds,
    }
  end
  local published_estimates = {}
  for id, e in pairs(estimates) do
    published_estimates[id] = {
      question = e.question, min = e.min, max = e.max, step = e.step, unit = e.unit,
      answer = e.answer, tolerance = e.tolerance, tolerancePct = e.tolerancePct, bins = e.bins,
    }
  end
  local published_ranks = {}
  for id, r in pairs(ranks) do
    published_ranks[id] = { question = r.question, items = r.items, top = r.top }
  end
  local published_hotspots = {}
  for id, h in pairs(hotspots) do
    published_hotspots[id] = { question = h.question, image = h.image, alt = h.alt, answer = h.answer }
  end
  for id, cloud in pairs(clouds) do
    published_clouds[id] = { question = cloud.question, maxWords = cloud.maxWords }
  end
  local published_likerts = {}
  for id, likert in pairs(likerts) do
    published_likerts[id] = {
      question = likert.question,
      statements = likert.statements,
      labels = likert.labels,
      numeric = likert.numeric,
      anchors = likert.anchors,
      single = likert.single,
    }
  end

  local config = {
    title = meta.title and meta_value(meta.title) or nil,
    position = position,
    autoActivate = auto_activate,
    menu = in_menu,
    server = seminar and meta_value(seminar.server) or nil,
    url = seminar and meta_value(seminar.url) or nil,
    room = seminar and meta_value(seminar.room) or nil,
    hash = seminar and meta_value(seminar.hash) or nil,
    order = poll_order,
    polls = published_polls,
    cloudOrder = cloud_order,
    clouds = published_clouds,
    likertOrder = likert_order,
    likerts = published_likerts,
    estimates = next(published_estimates) and published_estimates or nil,
    ranks = next(published_ranks) and published_ranks or nil,
    hotspots = next(published_hotspots) and published_hotspots or nil,
    timers = next(timers) and timers or nil,
    qa = qa,
    quiz = quiz,
    -- both opt-in: not every room wants them
    signals = switch("signals", false),
    reactions = switch("reactions", false),
    signalWindow = signal_window,
    ids = ids,
    recorded = read_session(meta),
  }

  -- `</` is escaped so the JSON can never close the <script> element early.
  local json = quarto.json.encode(config):gsub("</", "<\\/")

  quarto.doc.include_text("in-header", cdn)
  quarto.doc.include_text(
    "in-header",
    '<script type="application/json" id="livepoll-config">' .. json .. "</script>"
  )
  quarto.doc.add_html_dependency({
    name = "livepoll",
    -- Part of the site_libs path. Bump it with any change to these files: the
    -- path has no cache-busting otherwise, and a browser that has seen the old
    -- livepoll.css keeps using it against the new livepoll.js.
    version = "2.0.2",
    -- livepoll.js first: the others build on window.Livepoll
    scripts = { "qrcode.js", "livepoll.js", "timer.js", "questions.js", "qa.js", "signals.js", "quiz.js" },
    stylesheets = { "livepoll.css" },
  })

  return nil
end

return {
  -- pass 1: read every poll, whichever syntax it uses, before anything is
  -- rewritten — so a .poll-results div can sit anywhere relative to its poll.
  {
    Header = function(el)
      last_header = inlines_text(el.content)
      return nil
    end,
    Div = function(el)
      collect_div(el)
      collect_cloud(el)
      return collect_likert(el) or collect_estimate(el) or collect_rank(el) or collect_hotspot(el)
    end,
    RawBlock = collect_rawblock,
    Meta = read_layout,
  },
  -- pass 2: replace the authoring divs with the markup the plugins expect
  {
    Div = generate_div,
    Pandoc = emit,
  },
}
