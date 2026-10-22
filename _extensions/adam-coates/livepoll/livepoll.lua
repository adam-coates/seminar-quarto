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

-- The div's own `layout=`, or nil to take the deck default at generate time.
local function layout_attr(el, id)
  local v = el.attributes["layout"]
  if v == nil then return nil end
  if LAYOUTS[v] then return LAYOUTS[v] end
  quarto.log.warning("livepoll: '" .. id .. "' has unknown layout '" .. v .. "' (use classic or embedded), using the deck default.")
  return nil
end

local function read_layout(meta)
  if not meta.livepoll or not meta.livepoll.layout then return nil end
  local v = pandoc.utils.stringify(meta.livepoll.layout)
  if LAYOUTS[v] then
    default_layout = LAYOUTS[v]
  else
    quarto.log.warning("livepoll: unknown layout '" .. v .. "' (use classic or embedded), using classic.")
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

  local options, correct = {}, nil
  for i, opt in ipairs(raw_options) do
    local letter = LETTERS:sub(i, i)
    local value = opt.value or letter
    local label = opt.label
    if letters and not opt.value then label = letter .. ". " .. label end
    -- `text` is the option without its letter, which the panel layout shows
    table.insert(options, { value = value, label = label, text = opt.label })
    if opt.correct then correct = value end
  end

  if el.attributes["correct"] then correct = el.attributes["correct"] end

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
  })
  return nil
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

  record_cloud(id, {
    question = question or last_header or id,
    maxWords = max_words,
    show_question = show,
    layout = layout_attr(el, id),
    qr = truthy(el.attributes["qr"]) ~= false,
  })
  return nil
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

local function poll_html(id)
  local poll = polls[id]
  local out = {}
  if poll.show_question then out[#out + 1] = question_html(id) end
  out[#out + 1] = '<div class="poll" data-poll="' .. html_escape(id) .. '">'
  for _, opt in ipairs(poll.options) do
    out[#out + 1] = '<button data-value="'
      .. html_escape(opt.value)
      .. '">'
      .. html_escape(opt.label)
      .. "</button>"
  end
  out[#out + 1] = "</div>"
  out[#out + 1] = '<p class="poll-voters">Responses: <span class="voters" data-poll="'
    .. html_escape(id)
    .. '">0</span></p>'
  return table.concat(out, "\n")
end

local function results_html(id, orientation, height, show_question)
  local poll = polls[id]
  local labels, zeros = {}, {}
  for _, opt in ipairs(poll.options) do
    table.insert(labels, opt.label)
    table.insert(zeros, "0")
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
    local label = nil
    for _, opt in ipairs(poll.options) do
      if opt.value == poll.correct then label = opt.label end
    end
    if label then
      out[#out + 1] = '<p class="poll-answer fragment" data-poll="'
        .. html_escape(id)
        .. '" data-correct="'
        .. html_escape(poll.correct)
        .. '">Correct answer: <strong>'
        .. html_escape(label)
        .. "</strong></p>"
    else
      quarto.log.warning(
        "livepoll: poll '" .. id .. "' marks '" .. poll.correct .. "' correct, but no option has that value."
      )
    end
  end

  return table.concat(out, "\n")
end

local function cloud_html(id, height)
  local cloud = clouds[id]
  local out = {}
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
local function panel_side_html(show_qr, count, label)
  local out = { '<div class="lp-side">' }
  if show_qr then
    out[#out + 1] = '<div class="lp-qr"></div>'
    out[#out + 1] = '<div class="lp-url"></div>'
  end
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
      .. '" data-results="' .. poll.results .. '">',
    '<div class="lp-main">',
  }
  if poll.show_question then out[#out + 1] = question_html(id) end
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
    "responses"
  )

  -- The answer is the same `.poll-answer` fragment the classic results slide
  -- uses, so the reveal, the late-joiner relay and the phones all work as
  -- before. Here it is only a step: the row turning green is the visible part.
  local answer = nil
  if poll.correct then
    for _, opt in ipairs(poll.options) do
      if opt.value == poll.correct then answer = option_label(poll, opt) end
    end
    if not answer then
      quarto.log.warning(
        "livepoll: poll '" .. id .. "' marks '" .. poll.correct .. "' correct, but no option has that value."
      )
    end
  end
  if answer then
    out[#out + 1] = '<p class="poll-answer fragment lp-step" data-poll="' .. eid
      .. '" data-correct="' .. html_escape(poll.correct) .. '">Correct answer: '
      .. html_escape(answer) .. "</p>"
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
    "words"
  )
  out[#out + 1] = "</div>"
  return table.concat(out, "\n")
end

local function generate_div(el)
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
    if not polls[id] then
      quarto.log.warning("livepoll: .poll-results refers to unknown poll '" .. id .. "'.")
      return nil
    end
    return pandoc.RawBlock(
      "html",
      results_html(
        id,
        el.attributes["orientation"],
        el.attributes["height"] or "360px",
        truthy(el.attributes["show-question"]) == true
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

  local recorded = { polls = {}, clouds = {} }
  local any = false

  for _, rec in ipairs(session.polls or {}) do
    local poll = rec.id and polls[rec.id]
    if not poll then
      quarto.log.warning("livepoll: " .. name .. " has poll '" .. tostring(rec.id) .. "', which is not in this deck")
    else
      local votes, total = recorded_votes(rec.id, poll, rec)
      if total > 0 then
        recorded.polls[rec.id] = { votes = votes, voters = tonumber(rec.voters) or total }
        any = true
      end
    end
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

  if not any then return nil end
  -- an empty Lua table would encode as [] rather than {}
  if next(recorded.polls) == nil then recorded.polls = nil end
  if next(recorded.clouds) == nil then recorded.clouds = nil end
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

  if #poll_order == 0 and #cloud_order == 0 then
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
    }
  end
  for id, cloud in pairs(clouds) do
    published_clouds[id] = { question = cloud.question, maxWords = cloud.maxWords }
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
    version = "1.5.0",
    scripts = { "qrcode.js", "livepoll.js" },
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
      return nil
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
