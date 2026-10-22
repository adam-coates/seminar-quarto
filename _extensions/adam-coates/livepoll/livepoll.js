/*****************************************************************
** livepoll — presenter control panel for the seminar/poll plugins.
**
** Replaces the two reveal-menu panels that used to be spliced in by
** postprocess.py (`foobar` / `pollmenu`). The markup is identical in the parts
** that matter — the element ids (#broadcast, #username, #password,
** #startSeminar, #stopSeminar, #logger, #pollControl, #pollSelector,
** #activatePoll, #deactivatePoll, #activePollDisplay) are unchanged — it is
** just built at runtime instead of being handed to reveal-menu as a string.
**
** Loaded in <head>, so window.seminarStatusLogger exists before
** Reveal.initialize() evaluates the seminar plugin config.
******************************************************************/

(function () {
  // Nothing to control in a PDF export.
  if (/print-pdf/gi.test(window.location.search)) return;

  // Tracks whether the status logger has fired at least once. Same meaning as
  // the `isConnected` global postprocess.py used to declare.
  window.isConnected = false;

  var currentActivePoll = null;

  // Published by livepoll.lua into <head>. Also what poll.html reads.
  function deckConfig() {
    var el = document.getElementById("livepoll-config");
    if (!el) return {};
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      console.warn("livepoll: could not parse #livepoll-config", e);
      return {};
    }
  }

  /* ---------------------------------------------------------------- panel */

  function panelMarkup() {
    return (
      '<div class="livepoll-header">' +
      "  <span>Live poll control</span>" +
      '  <button type="button" class="livepoll-close" title="Close (Shift+L)">&times;</button>' +
      "</div>" +
      '<div class="livepoll-section" id="broadcast">' +
      "  <h3>Seminar</h3>" +
      "  <form>" +
      "    <table>" +
      '      <tr><td>User name:</td><td><input type="text" id="username" size="13"></td></tr>' +
      '      <tr><td>Password:</td><td><input type="password" id="password" size="13"></td></tr>' +
      "    </table>" +
      '    <button id="startSeminar" type="submit">Start</button>' +
      '    <button id="stopSeminar" type="button">Stop</button>' +
      "  </form>" +
      "  <p>Status log:</p>" +
      '  <textarea id="logger" spellcheck="false" readonly>Trying to connect to server ...\n</textarea>' +
      "</div>" +
      '<div class="livepoll-section" id="pollControl">' +
      "  <h3>Poll control</h3>" +
      "  <p>Active poll: <span id='activePollDisplay'>None</span></p>" +
      '  <select id="pollSelector"><option value="">-- Select Poll --</option></select>' +
      '  <button id="activatePoll" type="button">Activate</button>' +
      '  <button id="deactivatePoll" type="button">Deactivate</button>' +
      '  <button id="clearCloud" type="button">Clear words</button>' +
      "  <p class='livepoll-hint'>Activate a poll to enable voting on the standalone poll page. Shift+Q shows the QR code full screen.</p>" +
      "</div>"
    );
  }

  function buildPanel() {
    var panel = document.createElement("div");
    panel.id = "livepoll-panel";
    panel.innerHTML = panelMarkup();
    document.body.appendChild(panel);

    // The reveal menu is the way in when the controls live there; the button
    // is only for the floating panel. menuPanelRef is already known here:
    // Reveal.initialize runs inline, before DOMContentLoaded.
    if (!menuPanelRef) addToggle();

    // Keep reveal.js from acting on keystrokes typed into the panel.
    panel.addEventListener("keydown", consumeBroadcastEvent);

    panel.querySelector(".livepoll-close").addEventListener("click", togglePanel);

    // Capture phase, and stopped: while the reveal menu is open it reads L as
    // "next tab" and swallows the key, so a bubble-phase listener here never
    // got the second Shift+L that should close it again.
    document.addEventListener(
      "keydown",
      function (evt) {
        var tag = (evt.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (evt.key === "L" && evt.shiftKey && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
          evt.preventDefault();
          evt.stopImmediatePropagation();
          togglePanel();
        }
      },
      true
    );
  }

  // The floating panel's button. Default top-right: bottom-left is reveal's
  // own menu button, bottom-right is the slide number. Override with
  // top-level `livepoll: position:`
  // (top-right | top-left | bottom-right | bottom-left | hidden).
  function addToggle() {
    var position = deckConfig().position || "top-right";
    if (position === "hidden" || document.getElementById("livepoll-toggle")) return;
    var toggle = document.createElement("button");
    toggle.id = "livepoll-toggle";
    toggle.className = "livepoll-" + position;
    toggle.type = "button";
    toggle.title = "Live poll control (Shift+L)";
    toggle.innerHTML = "&#128225;"; // satellite antenna
    document.body.appendChild(toggle);
    toggle.addEventListener("click", togglePanel);
  }

  function togglePanel() {
    if (inMenu) {
      toggleMenuTab();
      return;
    }
    var panel = document.getElementById("livepoll-panel");
    panel.classList.toggle("open");
  }

  // Stops reveal (and, inside the menu, the menu's own j/k/h/l navigation)
  // from acting on keystrokes typed into the controls. Both listen on document
  // in the bubble phase, so stopping the event on its way up is enough.
  function consumeBroadcastEvent(evt) {
    evt.stopPropagation();
  }

  /* --------------------------------------------------- in the reveal menu */

  // The controls live in a "Live poll" tab of Quarto's reveal menu, beside
  // Slides and Tools. reveal-menu builds its tabs once, from the `menu.custom`
  // list in the config handed to Reveal.initialize, and Quarto writes that list
  // inline in the page. It cannot come from this extension's YAML: a `menu:`
  // block there replaces Quarto's whole menu config instead of merging into it,
  // and the Tools tab, the menu side and the open button all go with it.
  //
  // So the tab is added on the way in: this file loads in <head>, before
  // reveal.js defines window.Reveal, and wraps Reveal.initialize as soon as it
  // appears. The tab's content is an empty slot; once the menu has built it,
  // moveIntoMenu() moves the panel's sections in, event listeners and all.
  // Without the menu plugin (or with `livepoll: menu: false`) nothing changes
  // and the floating panel is used as before.
  var menuPanelRef = null; // the tab's data-panel, "CustomN"
  var inMenu = false; // true once the sections have moved

  function addMenuTab(config) {
    if (!config || !config.menu || !Array.isArray(config.plugins)) return;
    if (!window.RevealMenu || config.plugins.indexOf(window.RevealMenu) === -1) return;
    if (deckConfig().menu === false) return;
    var custom = config.menu.custom || (config.menu.custom = []);
    custom.push({
      title: "Live poll",
      icon: '<i class="fas fa-tower-broadcast"></i>',
      content: '<div id="livepoll-menu-slot"></div>',
    });
    menuPanelRef = "Custom" + (custom.length - 1);
  }

  function patchInitialize(reveal) {
    if (!reveal || typeof reveal.initialize !== "function" || reveal._livepollPatched) return;
    var initialize = reveal.initialize;
    reveal.initialize = function (config) {
      try {
        addMenuTab(config);
      } catch (e) {
        console.warn("livepoll: could not add the menu tab", e);
      }
      return initialize.apply(this, arguments);
    };
    reveal._livepollPatched = true;
  }

  if (window.Reveal) {
    patchInitialize(window.Reveal);
  } else {
    var heldReveal;
    Object.defineProperty(window, "Reveal", {
      configurable: true,
      enumerable: true,
      get: function () {
        return heldReveal;
      },
      set: function (value) {
        heldReveal = value;
        patchInitialize(value);
      },
    });
  }

  // The menu builds itself after loading its stylesheet, so wait for the slot.
  function moveIntoMenu(attemptsLeft) {
    if (!menuPanelRef) return;
    var slot = document.getElementById("livepoll-menu-slot");
    if (!slot) {
      if (attemptsLeft === undefined) attemptsLeft = 100; // ~10s
      if (attemptsLeft > 0) {
        setTimeout(function () {
          moveIntoMenu(attemptsLeft - 1);
        }, 100);
      } else {
        console.warn("livepoll: the menu never built its tab; keeping the floating panel");
        addToggle();
      }
      return;
    }
    var panel = document.getElementById("livepoll-panel");
    var sections = panel.querySelectorAll(".livepoll-section");
    for (var i = 0; i < sections.length; i++) slot.appendChild(sections[i]);
    slot.addEventListener("keydown", consumeBroadcastEvent);
    panel.classList.remove("open");
    inMenu = true;
  }

  function toggleMenuTab() {
    var menu = window.Reveal && Reveal.getPlugin && Reveal.getPlugin("menu");
    if (!menu) return;
    var showing = document.querySelector(
      '.slide-menu-panel.active-menu-panel[data-panel="' + menuPanelRef + '"]'
    );
    if (menu.isOpen() && showing) {
      menu.closeMenu(null, true);
    } else {
      menu.openPanel(null, menuPanelRef);
    }
  }

  /* --------------------------------------------------------------- logger */

  window.seminarStatusLogger = function (message) {
    if (!window.isConnected) {
      // hide elements that are only displayed when not connected
      var showOnDisconnected =
        document.querySelectorAll(".seminar.disconnected") || [];
      for (var i = 0; i < showOnDisconnected.length; i++) {
        showOnDisconnected[i].style.display = "none";
      }
      // show elements that are only displayed when connected
      var showOnConnected = document.querySelectorAll(".seminar.connected") || [];
      for (var j = 0; j < showOnConnected.length; j++) {
        showOnConnected[j].style.display = "";
      }
      window.isConnected = true;
    }
    var element = document.getElementById("logger");
    if (element) {
      while ((element.value.match(/\n/g) || []).length >= 10) {
        // Limit number of lines in log to 10
        element.value = element.value.substring(element.value.indexOf("\n") + 1);
      }
      element.value += "> " + message + "\n";
    }
  };

  /* ------------------------------------------------------------- controls */

  function initSeminarControls() {
    document
      .getElementById("startSeminar")
      .addEventListener("click", function (evt) {
        evt.preventDefault();
        RevealSeminar.open_or_join_room(
          document.getElementById("password").value,
          (document.getElementById("username") || {}).value || "Lecturer"
        );
      });

    document
      .getElementById("stopSeminar")
      .addEventListener("click", function (evt) {
        evt.preventDefault();
        if (
          confirm(
            "Are you sure you want to close the seminar for all participants?"
          )
        ) {
          RevealSeminar.close_room(document.getElementById("password").value);
        }
      });
  }

  function initPollControls() {
    var pollSelector = document.getElementById("pollSelector");
    var items = document.querySelectorAll(
      ".poll[data-poll], .wordcloud[data-wordcloud], .likert[data-likert]"
    );

    for (var i = 0; i < items.length; i++) {
      var itemId =
        items[i].getAttribute("data-poll") ||
        items[i].getAttribute("data-wordcloud") ||
        items[i].getAttribute("data-likert");
      var option = document.createElement("option");
      option.value = itemId;
      option.textContent = itemId;
      pollSelector.appendChild(option);
    }

    document
      .getElementById("activatePoll")
      .addEventListener("click", function (evt) {
        evt.preventDefault();
        if (!pollSelector.value) {
          alert("Please select a poll first");
          return;
        }
        activatePoll(pollSelector.value);
      });

    document
      .getElementById("deactivatePoll")
      .addEventListener("click", function (evt) {
        evt.preventDefault();
        deactivatePolls();
      });

    document
      .getElementById("clearCloud")
      .addEventListener("click", function (evt) {
        evt.preventDefault();
        var id = pollSelector.value || currentActivePoll;
        if (!id || !(deckConfig().clouds || {})[id]) {
          alert("Select a word cloud first");
          return;
        }
        if (!window.RevealSeminar || !RevealSeminar.hosting()) {
          alert("You must be hosting the seminar to clear a word cloud");
          return;
        }
        if (!confirm("Remove every word submitted to \"" + id + "\"?")) return;
        clearCloud(id);
        window.seminarStatusLogger("Cleared word cloud: " + id);
      });
  }

  /* ------------------------------------------------ activate / deactivate */

  // `quiet` is used by the automatic activation, which must not nag the user
  // about not hosting — it fires on every slide change.
  function activatePoll(pollId, quiet) {
    if (!pollId) return false;
    if (!window.RevealSeminar || !RevealSeminar.hosting()) {
      if (!quiet) alert("You must be hosting the seminar to activate polls");
      return false;
    }
    if (currentActivePoll === pollId) return false;

    var message = new CustomEvent("broadcast");
    message.content = {
      sender: "poll-control",
      type: "activate-poll",
      pollId: pollId,
    };
    document.dispatchEvent(message);

    currentActivePoll = pollId;
    var display = document.getElementById("activePollDisplay");
    if (display) display.textContent = pollId;
    var selector = document.getElementById("pollSelector");
    if (selector) selector.value = pollId;
    window.seminarStatusLogger("Activated poll: " + pollId);
    updatePills();
    return true;
  }

  function deactivatePolls(quiet) {
    if (!window.RevealSeminar || !RevealSeminar.hosting()) {
      if (!quiet) alert("You must be hosting the seminar to deactivate polls");
      return false;
    }

    var message = new CustomEvent("broadcast");
    message.content = { sender: "poll-control", type: "deactivate-poll" };
    document.dispatchEvent(message);

    currentActivePoll = null;
    var display = document.getElementById("activePollDisplay");
    if (display) display.textContent = "None";
    var selector = document.getElementById("pollSelector");
    if (selector) selector.value = "";
    window.seminarStatusLogger("Deactivated all polls");
    updatePills();
    return true;
  }

  /* ------------------------------------------------------- word clouds */

  var cloudCounts = {}; // cloudId -> { word: count }
  var cloudPending = {}; // cloudId -> true while a repaint is queued

  // Colour identifies the word, size carries the frequency. Derived from the
  // text itself, so a word keeps its colour for its whole life — including
  // when its count changes, and across every connected deck — and nothing has
  // to be remembered or agreed between them.
  function hashString(text) {
    var hash = 2166136261; // FNV-1a
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
  }

  function colourForWord(word) {
    return "hsl(" + (hashString(word) % 360) + ", 62%, 45%)";
  }

  var raf =
    window.requestAnimationFrame ||
    function (cb) {
      return setTimeout(cb, 16);
    };

  function cloudBox(id) {
    return document.querySelector('.wordcloud[data-wordcloud="' + id + '"]');
  }

  // Slide coordinates, not screen pixels. offsetWidth/offsetHeight are layout
  // sizes, so they ignore every CSS transform sitting above the element. That
  // matters for more than reveal's own scale, which is why dividing
  // getBoundingClientRect() by Reveal.getScale() was not enough:
  //
  //   * reveal's zoom plugin (ctrl+click on Linux, alt+click elsewhere) puts a
  //     scale(2) on <body> for as long as you stay zoomed in, and Reveal.getScale()
  //     knows nothing about it. Measuring during a zoom sized the chart at twice
  //     its real size, and since nothing re-measures on zoom out, it stayed that
  //     way — the bars then drew outside the chart's box, which looks exactly
  //     like votes no longer arriving.
  //   * the same transform animates for 0.8s, so a measurement taken mid-zoom
  //     landed on some arbitrary fraction in between.
  function slideBox(el) {
    return { width: el.offsetWidth, height: el.offsetHeight };
  }

  /* ---- text measurement ---- */

  var measureCtx; // undefined = not tried yet, false = unavailable

  function measure(text, fontSize, fontFamily) {
    if (measureCtx === undefined) {
      var canvas = document.createElement("canvas");
      try {
        measureCtx = canvas.getContext ? canvas.getContext("2d") : false;
      } catch (e) {
        measureCtx = false;
      }
      if (!measureCtx) measureCtx = false;
    }
    if (measureCtx) {
      measureCtx.font = "700 " + fontSize + "px " + fontFamily;
      return { w: measureCtx.measureText(text).width, h: fontSize * 1.16 };
    }
    // no canvas (e.g. under test): a good enough average glyph width
    return { w: text.length * fontSize * 0.58, h: fontSize * 1.16 };
  }

  /* ---- layout ----
   *
   * Deterministic on purpose. The same tally always produces the same
   * arrangement, so when one word gains a vote the others mostly keep their
   * places and CSS can animate the difference. A canvas word cloud repaints
   * from scratch every time, which is what made words flicker in and out.
   */

  function overlaps(a, b) {
    return !(a.x2 <= b.x1 || a.x1 >= b.x2 || a.y2 <= b.y1 || a.y1 >= b.y2);
  }

  function placeWord(entry, placed, box, pad) {
    var cx = box.width / 2;
    var cy = box.height / 2;

    for (var t = 0; t < 3000; t++) {
      var angle = t * 0.22;
      var radius = 2.1 * angle;
      var x = cx + radius * Math.cos(angle) * 1.7; // slides are wider than tall
      var y = cy + radius * Math.sin(angle);

      var rect = {
        x1: x - entry.w / 2 - pad,
        x2: x + entry.w / 2 + pad,
        y1: y - entry.h / 2 - pad,
        y2: y + entry.h / 2 + pad,
      };
      if (rect.x1 < 0 || rect.y1 < 0 || rect.x2 > box.width || rect.y2 > box.height) {
        continue;
      }

      var clash = false;
      for (var i = 0; i < placed.length; i++) {
        if (overlaps(rect, placed[i])) {
          clash = true;
          break;
        }
      }
      if (!clash) {
        entry.x = x;
        entry.y = y;
        placed.push(rect);
        return true;
      }
    }
    return false;
  }

  function layoutCloud(counts, box, fontFamily) {
    var words = Object.keys(counts);
    if (!words.length) return [];

    // weight first, then alphabetical: a stable order regardless of arrival
    words.sort(function (a, b) {
      return counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0);
    });

    // Absolute scale, not normalised to the current leader. If sizes were
    // relative to the maximum, one extra vote for the top word would resize
    // every other word and move the whole cloud; this way only the word that
    // actually changed resizes, and the rest stay put.
    var cap = Math.min(box.height / 3, 120);
    var base = Math.max(18, Math.min(box.height / 9, 44));

    // shrink until everything fits, rather than dropping words
    for (var attempt = 0; attempt < 6; attempt++) {
      var scale = Math.pow(0.85, attempt);
      var placed = [];
      var laid = [];
      var dropped = false;

      for (var i = 0; i < words.length; i++) {
        var weight = counts[words[i]];
        var fontSize = Math.min(cap, base * Math.pow(weight, 0.6)) * scale;
        fontSize = Math.max(10, Math.round(fontSize));

        var size = measure(words[i], fontSize, fontFamily);
        var entry = {
          word: words[i],
          weight: weight,
          fontSize: fontSize,
          w: size.w,
          h: size.h,
        };
        if (placeWord(entry, placed, box, 4)) {
          laid.push(entry);
        } else {
          dropped = true;
          break;
        }
      }

      if (!dropped) return laid;
      if (attempt === 5) return laid; // give up shrinking, show what fits
    }
    return [];
  }

  /* ---- painting ---- */

  function paintCloud(id) {
    var box = cloudBox(id);
    if (!box) return;

    var counts = cloudCounts[id] || {};
    var words = Object.keys(counts);
    var total = 0;
    for (var i = 0; i < words.length; i++) total += counts[words[i]];

    var empty = box.querySelector('.wordcloud-empty[data-wordcloud="' + id + '"]');
    if (empty) empty.style.display = words.length ? "none" : "";

    var counter = document.querySelector('.word-count[data-wordcloud="' + id + '"]');
    if (counter) counter.innerHTML = total;

    var size = slideBox(box);
    if (!size.width || !size.height) return; // slide not on screen yet

    // The panel layout sets its own font on the box (the theme's heading font),
    // so measure in that, or the words are sized for one font and drawn in
    // another and run into each other.
    var themed = box.classList.contains("lp-cloud");
    var fontFamily =
      window.getComputedStyle(themed ? box : document.body).fontFamily || "sans-serif";
    var entries = layoutCloud(counts, size, fontFamily);

    var existing = {};
    var nodes = box.querySelectorAll(".wordcloud-word");
    for (var j = 0; j < nodes.length; j++) {
      existing[nodes[j].getAttribute("data-word")] = nodes[j];
    }

    // The panel layout also colours from the deck theme (livepoll.css): the
    // three biggest words in the accent, the rest in tones derived from the
    // word, so they too keep their colour as counts change.
    var kept = {};
    for (var k = 0; k < entries.length; k++) {
      var entry = entries[k];
      kept[entry.word] = true;

      var el = existing[entry.word];
      var isNew = !el;
      if (isNew) {
        el = document.createElement("span");
        el.className = "wordcloud-word entering";
        el.setAttribute("data-word", entry.word);
        el.textContent = entry.word;
        box.appendChild(el);
      }

      el.style.fontSize = entry.fontSize + "px";
      if (themed) {
        el.setAttribute("data-tone", k < 3 ? "0" : String(1 + (hashString(entry.word) % 3)));
      } else {
        el.style.color = colourForWord(entry.word);
      }
      el.style.transform =
        "translate(" + Math.round(entry.x) + "px," + Math.round(entry.y) +
        "px) translate(-50%,-50%)";

      if (isNew) {
        // one frame at the entering size, then transition to full size
        (function (node) {
          raf(function () {
            node.classList.remove("entering");
          });
        })(el);
      }
    }

    // words that no longer fit (or were cleared) fade out
    for (var word in existing) {
      if (kept[word]) continue;
      (function (node) {
        node.classList.add("leaving");
        setTimeout(function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        }, 500);
      })(existing[word]);
    }
  }

  // Coalesce bursts of votes into one repaint per frame.
  function renderCloud(id) {
    if (cloudPending[id]) return;
    cloudPending[id] = true;
    raf(function () {
      cloudPending[id] = false;
      paintCloud(id);
    });
  }

  function addWords(id, words) {
    if (!cloudCounts[id]) cloudCounts[id] = {};
    for (var i = 0; i < words.length; i++) {
      var word = String(words[i] || "").trim();
      if (!word) continue;
      cloudCounts[id][word] = (cloudCounts[id][word] || 0) + 1;
    }
  }

  function broadcastCounts(id) {
    var message = new CustomEvent("broadcast");
    message.content = {
      sender: "wordcloud-plugin",
      copy: true,
      type: "counts",
      cloud: id,
      counts: cloudCounts[id] || {},
    };
    document.dispatchEvent(message);
  }

  function clearCloud(id) {
    cloudCounts[id] = {};
    renderCloud(id);
    var message = new CustomEvent("broadcast");
    message.content = {
      sender: "wordcloud-plugin",
      copy: true,
      type: "clear",
      cloud: id,
    };
    document.dispatchEvent(message);
  }

  // A vote replaces the dataset's numbers; make sure the colours still match
  // whatever the answer fragment is doing.
  document.addEventListener("received", function (event) {
    var content = event.content;
    if (!content || content.sender !== "poll-plugin") return;
    if (content.type !== "results") return;
    setTimeout(function () {
      syncAnswerHighlight(content.poll);
    }, 0);
  });

  document.addEventListener("received", function (event) {
    var content = event.content;
    if (!content || content.sender !== "wordcloud-plugin") return;

    if (content.type === "word") {
      // only the host keeps the tally, exactly as the poll plugin does
      if (!window.RevealSeminar || !RevealSeminar.hosting()) return;
      addWords(content.cloud, content.words || [content.word]);
      renderCloud(content.cloud);
      broadcastCounts(content.cloud);
    } else if (content.type === "counts") {
      cloudCounts[content.cloud] = content.counts || {};
      renderCloud(content.cloud);
    } else if (content.type === "clear") {
      cloudCounts[content.cloud] = {};
      renderCloud(content.cloud);
    }
  });

  /* ------------------------------------------------------------ likert */

  // A rating scale (livepoll.lua, .likert): statements rated on one scale. Each
  // phone sends one answer for the whole question, a point index per statement
  // (null for one left out). Like votes and words, the tally is kept by the
  // hosting deck, which broadcasts it; every deck draws from the broadcast.

  var likertState = {}; // id -> { counts: [[n per point] per statement], voters }, as drawn
  // The host's own tally, kept apart from what is drawn: a replayed recording
  // fills likertState, and live answers start afresh rather than adding to it,
  // as they do for polls.
  var likertTally = {}; // id -> { counts, voters }, host only
  var likertAnswers = {}; // id -> { voterKey: true }, host only

  function likertDef(id) {
    return (deckConfig().likerts || {})[id];
  }

  function emptyCounts(def) {
    return def.statements.map(function () {
      return def.labels.map(function () {
        return 0;
      });
    });
  }

  // Same rule as poll.js: count people, not messages. The relay names the
  // sender; without one (an older relay) every message counts.
  function voterKey(sender) {
    if (!sender) return null;
    if (typeof sender === "string") return sender;
    return sender.id || sender.name || null;
  }

  function addLikertAnswer(id, answers, sender) {
    var def = likertDef(id);
    if (!def || !Array.isArray(answers)) return false;
    var state = likertTally[id] || (likertTally[id] = { counts: emptyCounts(def), voters: 0 });
    var voters = likertAnswers[id] || (likertAnswers[id] = {});
    var key = voterKey(sender);
    if (key) {
      if (voters[key]) return false; // already answered: a reload, not a person
      voters[key] = true;
    }
    var counted = false;
    for (var s = 0; s < def.statements.length; s++) {
      var p = answers[s];
      if (typeof p === "number" && p >= 0 && p < def.labels.length && p === Math.floor(p)) {
        state.counts[s][p]++;
        counted = true;
      }
    }
    if (!counted) {
      if (key) delete voters[key];
      return false;
    }
    state.voters++;
    return true;
  }

  function broadcastLikert(id) {
    var message = new CustomEvent("broadcast");
    message.content = {
      sender: "likert-plugin",
      copy: true,
      type: "counts",
      likert: id,
      counts: likertTally[id].counts,
      voters: likertTally[id].voters,
    };
    document.dispatchEvent(message);
  }

  document.addEventListener("received", function (event) {
    var content = event.content;
    if (!content || content.sender !== "likert-plugin") return;

    if (content.type === "answer") {
      // only the host keeps the tally
      if (!window.RevealSeminar || !RevealSeminar.hosting()) return;
      if (addLikertAnswer(content.likert, content.answers, event.sender)) {
        var tally = likertTally[content.likert];
        likertState[content.likert] = { counts: tally.counts, voters: tally.voters };
        renderLikert(content.likert);
        broadcastLikert(content.likert);
      }
    } else if (content.type === "counts") {
      var def = likertDef(content.likert);
      if (!def || !Array.isArray(content.counts)) return;
      likertState[content.likert] = { counts: content.counts, voters: content.voters || 0 };
      renderLikert(content.likert);
    }
  });

  var pctText = function (x) {
    return Math.round(x * 100) + "%";
  };
  var responsesText = function (n) {
    return n + (n === 1 ? " response" : " responses");
  };

  // Where each point's segment starts and how wide it is, as shares of the
  // statement's answers, laid out so the neutral point straddles zero.
  function diverging(counts) {
    var n = counts.length;
    var total = counts.reduce(function (a, b) { return a + b; }, 0);
    var share = counts.map(function (c) { return total > 0 ? c / total : 0; });
    var arm = Math.floor(n / 2);
    var neutral = n % 2 === 1 ? share[arm] : 0;
    var neg = share.slice(0, arm).reduce(function (a, b) { return a + b; }, 0);
    var pos = share.slice(n - arm).reduce(function (a, b) { return a + b; }, 0);
    var at = -(neg + neutral / 2);
    var start = share.map(function (x) {
      var here = at;
      at += x;
      return here;
    });
    return { start: start, width: share, neg: neg, pos: pos, total: total };
  }

  // How far the bars reach either side of zero, rounded up to a tenth, so all
  // statements share one axis.
  function extent(rows) {
    var left = 0, right = 0;
    rows.forEach(function (r) {
      var last = r.start.length - 1;
      left = Math.max(left, -(r.start[0] || 0));
      right = Math.max(right, (r.start[last] || 0) + (r.width[last] || 0));
    });
    var round = function (x) {
      return Math.min(1, Math.max(0.2, Math.ceil(x * 10 - 1e-9) / 10));
    };
    return { left: round(left), right: round(right) };
  }

  function summary(counts, values) {
    var total = counts.reduce(function (a, b) { return a + b; }, 0);
    if (total === 0) return null;
    var sum = 0;
    counts.forEach(function (c, i) { sum += c * values[i]; });
    var nth = function (k) {
      var seen = 0;
      for (var i = 0; i < counts.length; i++) {
        seen += counts[i];
        if (seen > k) return values[i];
      }
      return values[values.length - 1];
    };
    var median = (nth(Math.floor((total - 1) / 2)) + nth(Math.ceil((total - 1) / 2))) / 2;
    return { mean: sum / total, median: median, total: total };
  }

  function drawDiverging(box, counts) {
    var bars = counts.map(diverging);
    var ext = extent(bars);
    var span = ext.left + ext.right;
    var at = function (x) { return ((x + ext.left) / span) * 100; };
    var rows = box.querySelectorAll(".lp-lk-row");
    bars.forEach(function (b, s) {
      var row = rows[s];
      if (!row) return;
      row.querySelector(".lp-lk-axis").style.left = at(0).toFixed(3) + "%";
      var segs = row.querySelectorAll(".lp-lk-seg");
      for (var p = 0; p < segs.length; p++) {
        var w = b.width[p] || 0;
        segs[p].style.left = at(b.start[p] || 0).toFixed(3) + "%";
        segs[p].style.width = ((w / span) * 100).toFixed(3) + "%";
        segs[p].classList.toggle("lp-lk-zero", w === 0);
        segs[p].querySelector(".lp-lk-pct").textContent = w > 0 ? pctText(w) : "";
      }
      row.querySelector(".lp-lk-neg").textContent = b.total > 0 ? pctText(b.neg) : "";
      row.querySelector(".lp-lk-pos").textContent = b.total > 0 ? pctText(b.pos) : "";
      row.querySelector(".lp-lk-n").textContent = responsesText(b.total);
    });
  }

  function drawHistograms(box, counts, def) {
    var values = def.labels.map(Number);
    var n = def.labels.length;
    var max = 0;
    counts.forEach(function (c) { c.forEach(function (x) { if (x > max) max = x; }); });
    var rows = box.querySelectorAll(".lp-lk-row");
    counts.forEach(function (c, s) {
      var row = rows[s];
      if (!row) return;
      var bars = row.querySelectorAll(".lp-hist-bar");
      for (var p = 0; p < bars.length; p++) {
        var count = c[p] || 0;
        bars[p].style.height = max > 0 ? ((count / max) * 100).toFixed(2) + "%" : "0%";
        bars[p].querySelector(".lp-hist-n").textContent = count > 0 ? String(count) : "";
      }
      var sum = summary(c, values);
      row.querySelector(".lp-lk-n").textContent = responsesText(sum ? sum.total : 0);
      row.querySelector(".lp-lk-stats").textContent = sum
        ? "mean " + sum.mean.toFixed(1) + " · median " + sum.median
        : "";
      var mean = row.querySelector(".lp-hist-mean");
      mean.hidden = !sum;
      if (sum) mean.style.left = (((sum.mean - values[0] + 0.5) / n) * 100).toFixed(3) + "%";
    });
  }

  // The classic voting slide: one choice per statement, then Submit sends them
  // to the host the way a classic poll button sends its vote (poll.js, vote()).
  function initClassicLikerts() {
    var boxes = document.querySelectorAll(".lp-likert-classic[data-likert]");
    Array.prototype.forEach.call(boxes, function (box) {
      var id = box.getAttribute("data-likert");
      var def = likertDef(id);
      if (!def) return;
      var answers = def.statements.map(function () {
        return null;
      });
      var submit = box.querySelector(".likert-submit");

      box.querySelectorAll(".likert-choice").forEach(function (button) {
        button.addEventListener("click", function () {
          var s = Number(button.getAttribute("data-s"));
          answers[s] = Number(button.getAttribute("data-p"));
          button.parentElement.querySelectorAll(".likert-choice").forEach(function (b) {
            b.classList.toggle("selected", b === button);
          });
          submit.disabled = answers.some(function (a) {
            return a === null;
          });
          button.blur();
        });
      });

      submit.addEventListener("click", function () {
        if (!window.RevealSeminar || !RevealSeminar.connected()) {
          alert("You are currently not connected to the live poll. Your answer is ignored.");
          return;
        }
        var message = new CustomEvent("send");
        message.content = {
          sender: "likert-plugin",
          recipient: true,
          type: "answer",
          likert: id,
          answers: answers.slice(),
        };
        document.dispatchEvent(message);
        box.querySelectorAll("button").forEach(function (b) {
          b.disabled = true;
        });
        submit.classList.add("sent");
        submit.textContent = "Sent";
        submit.blur();
      });
    });
  }

  function renderLikert(id) {
    var def = likertDef(id);
    if (!def) return;
    var state = likertState[id] || { counts: emptyCounts(def), voters: 0 };

    var voters = document.querySelectorAll('.likert-voters[data-likert="' + id + '"]');
    for (var i = 0; i < voters.length; i++) voters[i].textContent = state.voters;

    // embedded
    var boxes = document.querySelectorAll('.lp-likert[data-likert="' + id + '"]');
    for (var j = 0; j < boxes.length; j++) {
      if (def.numeric) drawHistograms(boxes[j], state.counts, def);
      else drawDiverging(boxes[j], state.counts);
    }

    // classic results: dataset p is point p across the statements
    if (window.RevealChart) {
      var charts = document.querySelectorAll('canvas[data-chart][data-likert="' + id + '"]');
      for (var k = 0; k < charts.length; k++) {
        if (!charts[k].chart) continue; // not built yet; repainted on arrival
        for (var p = 0; p < def.labels.length; p++) {
          charts[k].chart.data.datasets[p].data = state.counts.map(function (row) {
            return row[p] || 0;
          });
        }
        charts[k].chart.update();
      }
    }
  }

  /* ------------------------------------------------------ panel layout */

  // A panel (livepoll.lua, layout="panel") is one slide holding the options as
  // bar rows plus a side column with the QR and the count. The votes arrive on
  // the same `results` messages the chart plugin draws from; nothing about the
  // protocol changes.

  function panelsFor(pollId) {
    return document.querySelectorAll('.livepoll-question[data-poll="' + pollId + '"]');
  }

  function panelOnSlide(slide, pollId) {
    if (!slide) return null;
    return slide.querySelector('.livepoll-question[data-poll="' + pollId + '"]');
  }

  // Bars are scaled to the leading option, the percentage is of all votes.
  function updatePanelBars(panel, votes) {
    var rows = panel.querySelectorAll(".lp-row[data-value]");
    var total = 0;
    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      var n = votes[rows[i].getAttribute("data-value")] || 0;
      total += n;
      if (n > max) max = n;
    }
    for (var j = 0; j < rows.length; j++) {
      var count = votes[rows[j].getAttribute("data-value")] || 0;
      rows[j].querySelector(".lp-fill").style.width =
        max > 0 ? ((count / max) * 100).toFixed(2) + "%" : "0%";
      rows[j].querySelector(".lp-n").textContent = count;
      rows[j].querySelector(".lp-pct").textContent =
        (total > 0 ? Math.round((count / total) * 100) : 0) + "%";
      rows[j].classList.toggle("lp-lead", max > 0 && count === max);
    }
  }

  document.addEventListener("received", function (event) {
    var content = event.content;
    if (!content || content.sender !== "poll-plugin") return;
    if (content.type !== "results" || !content.votes) return;
    var panels = panelsFor(content.poll);
    for (var i = 0; i < panels.length; i++) {
      updatePanelBars(panels[i], content.votes);
    }
  });

  // Results are hidden (results="hidden") until the answer is given or, for a
  // poll without one, until its results fragment is shown. The answer counts
  // as given on the same terms as the green bar in the classic chart: reveal's
  // own `visible` class *and* the presenter having actually stepped to it.
  function syncPanel(panel) {
    var pollId = panel.getAttribute("data-poll") || panel.getAttribute("data-likert");
    var answer = panel.querySelector(".poll-answer");
    var given =
      !!answer &&
      answer.classList.contains("visible") &&
      revealedAnswers[pollId] !== undefined;
    var correct = given ? answer.getAttribute("data-correct") : null;

    var rows = panel.querySelectorAll(".lp-row[data-value]");
    for (var i = 0; i < rows.length; i++) {
      var value = rows[i].getAttribute("data-value");
      rows[i].classList.toggle("lp-correct", given && value === correct);
      rows[i].classList.toggle("lp-dim", given && value !== correct);
    }

    var reveal = panel.querySelector(".lp-reveal");
    var shown = !!reveal && reveal.classList.contains("visible");
    var hidden = panel.getAttribute("data-results") === "hidden" && !given && !shown;
    panel.classList.toggle("lp-results-hidden", hidden);
  }

  function syncAllPanels() {
    var panels = document.querySelectorAll(
      ".livepoll-question[data-poll], .livepoll-question[data-likert]"
    );
    for (var i = 0; i < panels.length; i++) syncPanel(panels[i]);
  }

  // Give the panel whatever height is left on the slide below it, so the bars
  // and the cloud have a box to fill. Slide coordinates, as everywhere here.
  function fitPanelHeight(panel, slide) {
    var top = 0;
    var node = panel;
    while (node && node !== slide) {
      top += node.offsetTop;
      var parent = node.offsetParent;
      if (!parent || (!slide.contains(parent) && parent !== slide)) break;
      node = parent;
    }
    var slideHeight = Number(Reveal.getConfig().height) || 700;
    var available = slideHeight - top - 24;
    panel.style.height = Math.round(Math.max(280, Math.min(620, available))) + "px";
  }

  // Shrink the rows until they fit, for polls with many or long options.
  function fitPanelBars(panel) {
    var bars = panel.querySelector(".lp-bars, .lp-likert");
    var main = panel.querySelector(".lp-main");
    if (!bars || !main) return;
    var question = main.querySelector(".poll-question");
    var room = main.clientHeight - (question ? question.offsetHeight : 0) + 1;
    var scale = 1;
    bars.style.setProperty("--lp-fit", "1");
    while (scale > 0.6 && bars.scrollHeight > room) {
      scale -= 0.05;
      bars.style.setProperty("--lp-fit", scale.toFixed(2));
    }
  }

  // What participants type in: no scheme, and no ?deck= when the deck is
  // index.html, which poll.html falls back to by itself. The QR keeps the lot.
  function shortUrl(url) {
    return url.replace(/^https?:\/\//, "").replace(/\?deck=index\.html$/, "");
  }

  // A QR as SVG markup that scales to its box: a 3-module quiet zone, crisp
  // square modules. null if the QR library did not load.
  function qrSvgMarkup(url) {
    if (typeof qrcode !== "function") {
      console.warn("livepoll: QR library not loaded");
      return null;
    }
    var qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    var n = qr.getModuleCount();
    var margin = 3;
    var size = n + margin * 2;
    var d = "";
    for (var row = 0; row < n; row++) {
      for (var col = 0; col < n; col++) {
        if (qr.isDark(row, col)) d += "M" + (col + margin) + " " + (row + margin) + "h1v1h-1z";
      }
    }
    return (
      '<svg viewBox="0 0 ' + size + " " + size + '" shape-rendering="crispEdges"' +
      ' role="img" aria-label="QR code for the poll page">' +
      '<rect width="' + size + '" height="' + size + '" fill="#fff"/>' +
      '<path d="' + d + '" fill="#111"/></svg>'
    );
  }

  function renderPanelQRCodes() {
    var panels = document.querySelectorAll(".livepoll-question");
    if (!panels.length) return;
    var url = pollPageUrl();
    var svg = qrSvgMarkup(url);
    for (var i = 0; i < panels.length; i++) {
      var box = panels[i].querySelector(".lp-qr");
      if (box && svg) box.innerHTML = svg;
      var text = panels[i].querySelector(".lp-url");
      if (text) text.textContent = shortUrl(url);
    }
  }

  // The pill under the count: OFFLINE until this deck is in the room, then
  // LIVE while this question is the active poll and CLOSED otherwise. Beside
  // it, how many are in the room, when the relay says.
  var PILL_TEXT = { live: "LIVE", closed: "CLOSED", offline: "OFFLINE" };
  var roomSize = null;

  function updatePills() {
    var online = !!(window.RevealSeminar && RevealSeminar.connected && RevealSeminar.connected());
    var panels = document.querySelectorAll(".livepoll-question");
    for (var i = 0; i < panels.length; i++) {
      var id =
        panels[i].getAttribute("data-poll") ||
        panels[i].getAttribute("data-wordcloud") ||
        panels[i].getAttribute("data-likert");
      var state = !online ? "offline" : id === currentActivePoll ? "live" : "closed";
      var pill = panels[i].querySelector(".lp-pill");
      if (pill) {
        pill.setAttribute("data-state", state);
        pill.textContent = PILL_TEXT[state];
      }
      var joined = panels[i].querySelector(".lp-joined");
      if (joined) joined.textContent = online && roomSize !== null ? roomSize + " connected" : "";
    }
  }

  // seminar.js passes the relay's lists through as they come; count either
  // shape rather than guess which one this relay uses.
  function memberCount(list) {
    if (!list) return 0;
    if (Array.isArray(list)) return list.length;
    if (typeof list === "object") return Object.keys(list).length;
    return 0;
  }

  document.addEventListener("participants", function (event) {
    if (!event.content) return;
    roomSize = memberCount(event.content.participants);
    updatePills();
  });
  document.addEventListener("seminar", updatePills);

  /* ------------------------------------------- full-screen QR (Shift+Q) */

  // Works on every deck, whatever the layout: the poll page's QR, as big as the
  // screen allows. Shift+Q toggles it; a click or Esc closes it.
  var overlay = null;

  function buildOverlay() {
    var url = pollPageUrl();
    var svg = qrSvgMarkup(url);
    if (!svg) return null;
    var el = document.createElement("div");
    el.id = "livepoll-overlay";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Scan to join");
    el.hidden = true;
    el.innerHTML =
      '<div class="livepoll-overlay-card">' +
      '<div class="livepoll-overlay-title">Scan to join</div>' +
      '<div class="livepoll-overlay-qr">' + svg + "</div>" +
      '<div class="livepoll-overlay-url"></div>' +
      "</div>";
    el.querySelector(".livepoll-overlay-url").textContent = shortUrl(url);
    el.addEventListener("click", function () {
      el.hidden = true;
    });
    document.body.appendChild(el);
    return el;
  }

  function toggleOverlay() {
    if (!overlay) overlay = buildOverlay();
    if (overlay) overlay.hidden = !overlay.hidden;
  }

  // Capture phase, so Esc closes the overlay without also opening reveal's
  // overview underneath it.
  document.addEventListener(
    "keydown",
    function (evt) {
      var tag = (evt.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (evt.key === "Q" && evt.shiftKey && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        toggleOverlay();
      } else if (evt.key === "Escape" && overlay && !overlay.hidden) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        overlay.hidden = true;
      }
    },
    true
  );

  /* --------------------------------------------- automatic activation */

  // What a slide is about: poll buttons, a results chart, or a word cloud.
  function pollOnSlide(slide) {
    if (!slide || !slide.querySelector) return null;
    var el = slide.querySelector(
      ".poll[data-poll], canvas[data-chart][data-poll], .wordcloud[data-wordcloud], " +
        ".likert[data-likert], canvas[data-chart][data-likert]"
    );
    if (!el) return null;
    return (
      el.getAttribute("data-poll") ||
      el.getAttribute("data-wordcloud") ||
      el.getAttribute("data-likert")
    );
  }

  // Charts and clouds measure their container, which is meaningless while the
  // slide is off screen — so re-measure once it is on screen. This is what was
  // leaving the chart at the wrong size after a slide change.
  // Size a chart once, in slide coordinates. Chart.js has responsive:false for
  // these charts, so this is the only thing that ever sets their size — no
  // resize observer to fight with, and nothing to oscillate against.
  function sizeChart(canvas) {
    var box = canvas.parentElement;
    if (!box) return;
    var size = slideBox(box);
    if (!size.width || !size.height) return; // slide not on screen yet

    var key = size.width + "x" + size.height;
    canvas.style.width = size.width + "px";
    canvas.style.height = size.height + "px";

    if (!canvas.chart) {
      // the chart plugin has not built this one yet: size the element, and do
      // not record it as done so the next pass sizes the chart itself
      canvas.width = size.width;
      canvas.height = size.height;
      return;
    }

    if (canvas._livepollSize === key) return; // already this size: leave it alone
    canvas._livepollSize = key;
    canvas.chart.resize(size.width, size.height);
  }

  // Chart.js only paints when something asks it to, and every ask made while
  // this slide was off screen went to a canvas inside a display:none section,
  // where it may never have reached the pixels. The data model moved on, the
  // last drawn frame did not.
  //
  // That would not matter if anything asked again on the way back, but nothing
  // did: applyHighlight() returns early when the colours it wants are the ones
  // already recorded, and sizeChart() returns early when the size has not
  // changed. Both are correct about the model and both leave a stale frame on
  // screen — a bar still green after the answer was stepped back, or a chart
  // still empty after votes were counted while you were on the question slide.
  //
  // So repaint on arrival, unconditionally. "none" means redraw from the model
  // without animating: this is catching the pixels up, not a change.
  function repaint(canvas) {
    if (!canvas.chart) return;
    canvas.chart.update("none");
  }

  function refreshVisuals() {
    if (!window.Reveal || !Reveal.getCurrentSlide) return;
    var slide = Reveal.getCurrentSlide();
    if (!slide) return;

    // Panels first: their height is what the bars and the cloud lay out in.
    var panels = slide.querySelectorAll(".livepoll-question");
    for (var p = 0; p < panels.length; p++) {
      fitPanelHeight(panels[p], slide);
      fitPanelBars(panels[p]);
    }

    var charts = slide.querySelectorAll("canvas[data-chart]");
    for (var i = 0; i < charts.length; i++) {
      sizeChart(charts[i]);
    }
    syncAllAnswerHighlights();
    syncAllPanels();
    for (var k = 0; k < charts.length; k++) {
      repaint(charts[k]);
    }

    var clouds = slide.querySelectorAll(".wordcloud[data-wordcloud]");
    for (var j = 0; j < clouds.length; j++) {
      paintCloud(clouds[j].getAttribute("data-wordcloud"));
    }

    var scales = slide.querySelectorAll("[data-likert]");
    for (var l = 0; l < scales.length; l++) {
      renderLikert(scales[l].getAttribute("data-likert"));
    }
  }

  // Opening a poll or results slide makes that poll the live one. Leaving it
  // does not deactivate: participants who are still voting keep their buttons
  // until another poll comes up, or you press Deactivate.
  function autoActivateForCurrentSlide() {
    if (deckConfig().autoActivate === false) return;
    if (!window.Reveal || !Reveal.getCurrentSlide) return;
    activatePoll(pollOnSlide(Reveal.getCurrentSlide()), true);
  }

  /* ---------------------------------------------------- late-joiner relay */

  // Send the active poll to a participant who joins after it was activated,
  // along with its answer if that has already been revealed.
  document.addEventListener("welcome", function (event) {
    if (currentActivePoll && event.content && event.content.user) {
      var user = event.content.user.id;
      var message = new CustomEvent("send");
      message.content = {
        sender: "poll-control",
        recipient: user,
        type: "activate-poll",
        pollId: currentActivePoll,
      };
      document.dispatchEvent(message);

      if (likertState[currentActivePoll]) {
        var tally = new CustomEvent("send");
        tally.content = {
          sender: "likert-plugin",
          recipient: user,
          type: "counts",
          likert: currentActivePoll,
          counts: likertState[currentActivePoll].counts,
          voters: likertState[currentActivePoll].voters,
        };
        document.dispatchEvent(tally);
      }

      if (cloudCounts[currentActivePoll]) {
        var counts = new CustomEvent("send");
        counts.content = {
          sender: "wordcloud-plugin",
          recipient: user,
          type: "counts",
          cloud: currentActivePoll,
          counts: cloudCounts[currentActivePoll],
        };
        document.dispatchEvent(counts);
      }

      if (revealedAnswers[currentActivePoll] !== undefined) {
        var answer = new CustomEvent("send");
        answer.content = {
          sender: "poll-control",
          recipient: user,
          type: "reveal-answer",
          pollId: currentActivePoll,
          correct: revealedAnswers[currentActivePoll],
        };
        document.dispatchEvent(answer);
      }
    }
  });

  // Answer a poll page that asks which poll is currently active.
  document.addEventListener("received", function (event) {
    if (
      event.content &&
      event.content.sender === "poll-page" &&
      event.content.type === "request-active-poll"
    ) {
      if (currentActivePoll && RevealSeminar.hosting()) {
        var message = new CustomEvent("broadcast");
        message.content = {
          sender: "poll-control",
          type: "activate-poll",
          pollId: currentActivePoll,
        };
        document.dispatchEvent(message);
      }
    }
  });

  /* --------------------------------------------------------- QR codes */

  // Built at runtime, not at render time: the URL depends on where the deck is
  // actually being served from, which the renderer cannot know.
  // The deck may be served as a file (/test/index.html) or as a directory
  // (/test/, or even /test before the host redirects). Resolve poll.html
  // against the folder either way, never as a sibling of "test".
  function pollPageUrl() {
    var last = location.pathname.split("/").pop();
    var isFile = /\.html?$/i.test(last);
    var deck = isFile ? last : "index.html";
    var base = isFile
      ? location.href
      : location.origin + location.pathname.replace(/\/?$/, "/");
    return new URL("poll.html?deck=" + encodeURIComponent(deck), base).href;
  }

  function renderQRCodes() {
    var nodes = document.querySelectorAll(".livepoll-qr");
    if (!nodes.length) return;
    if (typeof qrcode !== "function") {
      console.warn("livepoll: QR library not loaded");
      return;
    }

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var url = node.getAttribute("data-url") || pollPageUrl();
      var size = node.getAttribute("data-size") || "320";

      var qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();

      var html =
        '<div class="livepoll-qr-code" style="width:' +
        parseInt(size, 10) +
        'px">' +
        qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) +
        "</div>";
      if (node.getAttribute("data-caption") !== "false") {
        html += '<div class="livepoll-qr-url">' + url + "</div>";
      }
      node.innerHTML = html;
    }
  }

  /* ---------------------------------------------------- answer reveal */

  var revealedAnswers = {}; // pollId -> correct value, for late joiners

  // A poll id can appear on more than one slide — the same `for=` written into
  // two .poll-results blocks, a recap of an earlier question, a leftover from
  // the template. Everything below therefore starts from an *answer fragment*
  // and only ever touches the chart on that fragment's own slide.
  //
  // document.querySelector returned the first chart in the deck no matter which
  // slide was asking, so with a duplicated id the deck painted one slide's bar
  // green on behalf of another slide's fragment — the green turned up before
  // that slide's answer had been given, and the chart that was showing never
  // went green at all.
  function slideOf(el) {
    return el && el.closest ? el.closest("section") : null;
  }

  function chartOnSlide(slide, pollId) {
    if (!slide) return null;
    return slide.querySelector(
      'canvas[data-chart][data-poll="' + pollId + '"]'
    );
  }

  function answerFragments(pollId) {
    return document.querySelectorAll(
      pollId
        ? '.poll-answer[data-poll="' + pollId + '"]'
        : ".poll-answer[data-poll]"
    );
  }

  // Paint the correct bar green, or put the base colour back. Idempotent: it
  // works out the colours it wants and only touches the chart if they differ
  // from what is already there, so it can be called as often as we like.
  function applyHighlight(canvas, pollId, correctValue) {
    if (!canvas || !canvas.chart) return;
    var poll = (deckConfig().polls || {})[pollId];
    if (!poll) return;
    var dataset = canvas.chart.data.datasets[0];
    if (!dataset) return;

    if (dataset._livepollBase === undefined) {
      dataset._livepollBase =
        typeof dataset.backgroundColor === "string"
          ? dataset.backgroundColor
          : "white";
    }

    var next = correctValue
      ? poll.options.map(function (opt) {
          return opt.value === correctValue ? "#2e9e4f" : dataset._livepollBase;
        })
      : dataset._livepollBase;

    if (JSON.stringify(next) === JSON.stringify(dataset.backgroundColor)) return;
    dataset.backgroundColor = next;
    canvas.chart.update();
  }

  // The answer line is a reveal fragment, and reveal keeps its own record of
  // which fragments are showing — including when you jump slides, come back to
  // a slide, or have the state pushed to you by the seminar broadcast. Read
  // that class rather than tracking the events ourselves, otherwise the green
  // gets out of step and turns up before the answer has been given.
  // Two conditions, and both are needed.
  //
  // `visible` is reveal's own record of the fragment, which is what keeps the
  // green in step when you leave a slide and come back. But reveal also adds
  // that class silently: every slide *behind* the current one has its fragments
  // marked shown, no event, no presenter involved. Jump forward through the
  // overview and every answer you skipped is now `visible`, so the bar went
  // green on a question that had not been asked yet.
  //
  // revealedAnswers is the deck's own record of the presenter having actually
  // given the answer — it is already what decides whether a late joiner is told
  // it. Requiring it too means the worst case is a bar that stays white a moment
  // too long, rather than one that gives the answer away.
  function syncFragment(fragment) {
    var pollId = fragment.getAttribute("data-poll");
    var slide = slideOf(fragment);
    var panel = panelOnSlide(slide, pollId);
    if (panel) syncPanel(panel);
    var canvas = chartOnSlide(slide, pollId);
    if (!canvas) return; // this copy of the answer has no chart beside it
    var given =
      fragment.classList.contains("visible") &&
      revealedAnswers[pollId] !== undefined;
    applyHighlight(
      canvas,
      pollId,
      given ? fragment.getAttribute("data-correct") : null
    );
  }

  // Pass no id to sync every answer in the deck.
  function syncAnswerHighlight(pollId) {
    var fragments = answerFragments(pollId);
    for (var i = 0; i < fragments.length; i++) {
      syncFragment(fragments[i]);
    }
  }

  function syncAllAnswerHighlights() {
    syncAnswerHighlight(null);
  }

  function broadcastAnswer(pollId, correct) {
    if (!window.RevealSeminar || !RevealSeminar.hosting()) return;
    var message = new CustomEvent("broadcast");
    message.content = {
      sender: "poll-control",
      type: "reveal-answer",
      pollId: pollId,
      correct: correct,
    };
    document.dispatchEvent(message);
  }

  function isAnswerFragment(el) {
    return el && el.classList && el.classList.contains("poll-answer");
  }

  // reveal.js dispatches its events without bubbling, so they have to be taken
  // from Reveal itself rather than from document.
  function whenRevealReady(callback, attemptsLeft) {
    if (window.Reveal && Reveal.isReady && Reveal.isReady()) {
      callback(window.Reveal);
      return;
    }
    if (attemptsLeft === undefined) attemptsLeft = 100; // ~10s, then give up
    if (attemptsLeft <= 0) {
      console.warn("livepoll: reveal.js never became ready; answer reveal is off");
      return;
    }
    setTimeout(function () {
      whenRevealReady(callback, attemptsLeft - 1);
    }, 100);
  }

  /* ------------------------------------------------- recorded session */

  // Results from a session.json beside the deck (livepoll.lua puts them in the
  // config as `recorded`), fed in as the messages a live session would have
  // sent. Everything that draws results listens to those already: poll.js and
  // the chart plugin, the embedded bars, the word clouds. So does session.js,
  // which is the point of going this way: present the re-rendered deck, press
  // Alt+R again, and the recorded results are in the new file instead of being
  // dropped as never voted on.
  //
  // Run after reveal's `ready`, which is when poll.js builds its tallies and the
  // chart plugin its charts. Hosting live afterwards starts each poll afresh:
  // the first new vote replaces the replayed numbers with the live tally.
  function replayRecorded() {
    var recorded = deckConfig().recorded;
    if (!recorded) return;
    function send(content) {
      var event = new CustomEvent("received");
      event.content = content;
      document.dispatchEvent(event);
    }
    var pollIds = Object.keys(recorded.polls || {});
    for (var i = 0; i < pollIds.length; i++) {
      var poll = recorded.polls[pollIds[i]];
      send({ sender: "poll-plugin", type: "voters", poll: pollIds[i], voters: poll.voters });
      send({ sender: "poll-plugin", type: "results", poll: pollIds[i], votes: poll.votes });
    }
    var likertIds = Object.keys(recorded.likerts || {});
    for (var k = 0; k < likertIds.length; k++) {
      var likert = recorded.likerts[likertIds[k]];
      send({ sender: "likert-plugin", type: "counts", likert: likertIds[k], counts: likert.counts, voters: likert.voters });
    }
    var cloudIds = Object.keys(recorded.clouds || {});
    for (var j = 0; j < cloudIds.length; j++) {
      send({ sender: "wordcloud-plugin", type: "counts", cloud: cloudIds[j], counts: recorded.clouds[cloudIds[j]] });
    }
  }

  function initRevealHooks() {
    whenRevealReady(function (Reveal) {
      setTimeout(replayRecorded, 0); // after every other `ready` listener
      Reveal.on("slidechanged", function () {
        autoActivateForCurrentSlide();
        refreshVisuals();
        // the chart plugin re-creates its charts 500 ms into the transition;
        // measure again once that has settled
        setTimeout(refreshVisuals, 600);
      });
      autoActivateForCurrentSlide(); // the slide we start on
      refreshVisuals();
      setTimeout(refreshVisuals, 300); // charts may not exist yet at ready

      // Pressing Start while already sitting on a poll slide should activate it.
      document.addEventListener("seminar", autoActivateForCurrentSlide);

      // A panel's results fragment (results="hidden", no answer to give).
      function syncRevealFragment(event) {
        var fragment = event.fragment;
        if (!fragment || !fragment.classList || !fragment.classList.contains("lp-reveal")) return;
        var panel = fragment.closest(".livepoll-question");
        if (panel) syncPanel(panel);
      }
      Reveal.on("fragmentshown", syncRevealFragment);
      Reveal.on("fragmenthidden", syncRevealFragment);

      Reveal.on("fragmentshown", function (event) {
        if (!isAnswerFragment(event.fragment)) return;
        // reveal also emits this while syncing its own state; only treat it as
        // "the presenter just gave the answer" if the fragment really is shown
        if (!event.fragment.classList.contains("visible")) return;
        var pollId = event.fragment.getAttribute("data-poll");
        var correct = event.fragment.getAttribute("data-correct");
        revealedAnswers[pollId] = correct;
        syncFragment(event.fragment);
        broadcastAnswer(pollId, correct);
      });

      Reveal.on("fragmenthidden", function (event) {
        if (!isAnswerFragment(event.fragment)) return;
        var pollId = event.fragment.getAttribute("data-poll");
        // The same answer may be written on a second slide; only forget it for
        // late joiners once none of its copies is showing.
        var others = answerFragments(pollId);
        var stillShown = false;
        for (var i = 0; i < others.length; i++) {
          if (
            others[i] !== event.fragment &&
            others[i].classList.contains("visible")
          ) {
            stillShown = true;
          }
        }
        if (!stillShown) delete revealedAnswers[pollId];
        syncFragment(event.fragment);
      });
    });
  }

  /* ------------------------------------------------------------- start up */

  document.addEventListener("DOMContentLoaded", function () {
    buildPanel();
    initSeminarControls();
    initPollControls();
    moveIntoMenu();
    renderQRCodes();
    renderPanelQRCodes();
    initClassicLikerts();
    syncAllPanels(); // results="hidden" panels start hidden
    updatePills();
    initRevealHooks();

    // Same as the .then() block postprocess.py used to splice into
    // Reveal.initialize: nothing is connected yet, so hide the elements that
    // are only meant to appear once a seminar is running.
    if (!window.isConnected) {
      var showOnConnected = document.querySelectorAll(".seminar.connected") || [];
      for (var i = 0; i < showOnConnected.length; i++) {
        showOnConnected[i].style.display = "none";
      }
    }
  });
})();
