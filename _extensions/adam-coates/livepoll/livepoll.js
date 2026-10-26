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

  // Published by livepoll.lua into <head>. Also what poll.html reads. Parsed
  // once: it is asked for on every vote.
  var parsedConfig = null;
  function deckConfig() {
    if (parsedConfig) return parsedConfig;
    var el = document.getElementById("livepoll-config");
    if (!el) return {};
    try {
      parsedConfig = JSON.parse(el.textContent);
    } catch (e) {
      console.warn("livepoll: could not parse #livepoll-config", e);
      parsedConfig = {};
    }
    return parsedConfig;
  }

  /* ------------------------------------------------------- shared API */

  // What the other modules build on: timer.js, qa.js, questions.js,
  // signals.js and quiz.js, and poll.js and session.js where they need it. It
  // is the same plumbing this file uses itself, given names.
  var LP = (window.Livepoll = window.Livepoll || {});

  LP.config = deckConfig;

  LP.hosting = function () {
    return !!(window.RevealSeminar && RevealSeminar.hosting && RevealSeminar.hosting());
  };

  LP.connected = function () {
    return !!(window.RevealSeminar && RevealSeminar.connected && RevealSeminar.connected());
  };

  // To everyone in the room, as an announcement. `copy` (default false) has
  // the relay send it back to this deck too.
  LP.broadcast = function (content) {
    var message = new CustomEvent("broadcast");
    message.content = content;
    document.dispatchEvent(message);
  };

  // To one participant, as an announcement: the late-joiner sync. seminar.js
  // sends it; a phone believes an announcement where it would not believe a
  // message, which anyone in the room can send.
  LP.sendTo = function (userId, content) {
    if (!userId) return;
    var message = new CustomEvent("announce-to");
    message.content = Object.assign({}, content, { recipient: userId });
    document.dispatchEvent(message);
  };

  // To the host, from a deck being followed (the classic slides' buttons).
  LP.toHost = function (content) {
    var message = new CustomEvent("send");
    message.content = Object.assign({ recipient: true, device: LP.deviceId() }, content);
    document.dispatchEvent(message);
  };

  // A message is what any participant can send to anyone; an announcement only
  // a host can. A received event without a channel was dispatched by this page
  // itself (a replayed recording, a restore). State shown to the room is only
  // ever taken from the latter two.
  LP.trusted = function (event) {
    return !event || event.channel !== "message";
  };

  function randomId(length) {
    var alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    var out = "";
    var bytes = new Uint8Array(length);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    for (var i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }
  LP.randomId = randomId;

  // One per browser, shared with poll.html (same origin, same key, same
  // format): someone with both the deck and the poll page open is one person.
  // It lasts DEVICE_TTL after it was last used, so next week's class meets a
  // stranger; only a deck that opts into `ids: persistent` keeps it for good.
  var DEVICE_TTL = 12 * 3600 * 1000;
  var memoryDevice = null;
  LP.deviceId = function () {
    if (memoryDevice) return memoryDevice;
    var persistent = LP.config().ids === "persistent";
    var stored = null;
    try {
      stored = JSON.parse(localStorage.getItem("livepoll_device"));
    } catch (e) {
      /* a bare string is an id from before ids expired: start afresh */
    }
    var id = stored && typeof stored.id === "string" ? stored.id : null;
    if (id && !persistent && !(Date.now() - stored.t < DEVICE_TTL)) id = null;
    memoryDevice = id || randomId(16);
    try {
      localStorage.setItem("livepoll_device", JSON.stringify({ id: memoryDevice, t: Date.now() }));
    } catch (e) {
      /* kept in memory for this page, then */
    }
    return memoryDevice;
  };

  // Same rule as poll.js: count people, not messages. The relay names the
  // sender; without one (an older relay) every message counts.
  function voterKey(sender) {
    if (!sender) return null;
    if (typeof sender === "string") return sender;
    return sender.id || sender.name || null;
  }

  function voterKeys(event, content) {
    var keys = [];
    var device = content && content.device;
    if (typeof device === "string" && device && device.length <= 64) keys.push("d:" + device);
    var socket = voterKey(event && event.sender);
    if (socket) keys.push("s:" + socket);
    return keys;
  }

  // Who sent a response, as recorded: the device where there is one.
  LP.who = function (event, content) {
    return voterKeys(event, content)[0] || null;
  };

  // Claim a place in `seen` for whoever sent this, or false if they have one.
  // Keyed by device and by connection both: a reload keeps the device id and a
  // forged device id keeps the connection, so voting twice takes changing both.
  // With neither (an old relay, an old page) every message counts, as before.
  LP.claim = function (seen, event, content) {
    var keys = voterKeys(event, content);
    for (var i = 0; i < keys.length; i++) if (seen[keys[i]]) return false;
    for (var j = 0; j < keys.length; j++) seen[keys[j]] = true;
    return keys[0] || true;
  };

  // The socket a participant is reachable on, for a reply to them alone.
  LP.socketOf = function (event) {
    return voterKey(event && event.sender);
  };

  // Tell a participant their answer was not counted because this device (or
  // connection) has answered already. Without it the page says "sent" and the
  // answer quietly goes nowhere.
  LP.refuse = function (event, id) {
    var socket = LP.socketOf(event);
    if (socket && LP.hosting()) LP.sendTo(socket, { sender: "poll-control", type: "refused", pollId: id });
  };

  LP.escape = function (text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  LP.log = function (message) {
    if (window.seminarStatusLogger) window.seminarStatusLogger(message);
  };

  // Listen for one sender's messages: handler(content, event).
  LP.on = function (sender, handler) {
    document.addEventListener("received", function (event) {
      var content = event.content;
      if (!content || content.sender !== sender) return;
      handler(content, event);
    });
  };

  // The correct answer as written into data-correct: one value, or a JSON
  // list when a question takes several (`- [x]` on more than one option).
  LP.correctSet = function (correct) {
    if (correct == null || correct === "") return [];
    if (Array.isArray(correct)) return correct.map(String);
    var text = String(correct);
    if (text.charAt(0) === "[") {
      try {
        return JSON.parse(text).map(String);
      } catch (e) {
        /* a value that happens to start with [ */
      }
    }
    return [text];
  };

  /* ----------------------------------------------------- session state */

  // A hosting session: one class. Phones key their "already voted" record by
  // it, so next week's deck with the same poll ids starts afresh while a
  // reload in this class stays locked. Kept across a restore, so a crashed
  // presenter does not hand everyone a second vote.
  var sessionId = null;
  LP.sessionId = function () {
    if (!sessionId && LP.hosting()) sessionId = randomId(10);
    return sessionId;
  };

  // Who is in the room, by socket: everyone but hosts and the speaker view's
  // slide previews. seminar.js passes on the relay's joins and leaves.
  var members = {};
  var hostIds = {};

  function counted(user) {
    return !!(user && user.id && !hostIds[user.id] && !/^livepoll-receiver/.test(user.name || ""));
  }

  function asList(list) {
    if (!list) return [];
    if (Array.isArray(list)) return list;
    if (typeof list === "object") return Object.keys(list).map(function (k) { return list[k]; });
    return [];
  }

  document.addEventListener("participants", function (event) {
    if (!event.content) return;
    hostIds = {};
    asList(event.content.hosts).forEach(function (h) {
      if (h && h.id) hostIds[h.id] = true;
    });
    members = {};
    asList(event.content.participants).forEach(function (p) {
      if (counted(p)) members[p.id] = p;
    });
    roomChanged();
  });
  document.addEventListener("entered", function (event) {
    var user = event.content && event.content.user;
    if (counted(user)) members[user.id] = user;
    roomChanged();
  });
  document.addEventListener("left", function (event) {
    var user = event.content && event.content.user;
    if (user && user.id) delete members[user.id];
    roomChanged();
  });
  document.addEventListener("seminar", function () {
    if (!LP.connected()) members = {};
    // the presenting deck's bars are a display, not buttons (livepoll.css)
    document.documentElement.classList.toggle("livepoll-hosting", LP.hosting());
    roomChanged();
  });

  LP.connectedCount = function () {
    return Object.keys(members).length;
  };

  function roomChanged() {
    updatePills();
    LP.hud.refresh();
  }

  // Voting on a question can be closed (a timer ran out, or the presenter
  // closed it) while it stays the active one: the phones keep the question on
  // screen and stop taking answers, and the host refuses any that still arrive.
  var closed = {};
  LP.isOpen = function (id) {
    return !closed[id];
  };

  LP.close = function (id) {
    if (!id || !LP.hosting() || closed[id]) return;
    LP.broadcast({ sender: "poll-control", copy: true, type: "close-poll", pollId: id });
  };

  LP.reopen = function (id) {
    if (!id || !LP.hosting() || !closed[id]) return;
    LP.broadcast({ sender: "poll-control", copy: true, type: "reopen-poll", pollId: id });
  };

  LP.on("poll-control", function (content, event) {
    if (!LP.trusted(event)) return;
    if (content.type === "close-poll" || content.type === "reopen-poll") {
      var shut = content.type === "close-poll";
      if (!!closed[content.pollId] === shut) return;
      if (shut) closed[content.pollId] = true;
      else delete closed[content.pollId];
      document.dispatchEvent(new CustomEvent("livepoll-closed", { detail: { id: content.pollId, closed: shut } }));
      updatePills();
      LP.hud.refresh();
      LP.dirty();
    }
  });

  // When each question was first opened in this session, for response times.
  var openedAt = {};
  LP.openedAt = function (id) {
    return openedAt[id] || null;
  };

  // Every response the host accepts, as an event: session.js keeps them (with
  // their times) for the export, quiz.js scores them. `who` is LP.who().
  var responseCount = 0;
  LP.response = function (detail) {
    responseCount++;
    document.dispatchEvent(new CustomEvent("livepoll-response", { detail: Object.assign({ t: Date.now() }, detail) }));
    LP.hud.refresh();
    LP.dirty();
  };

  /* ---------------------------------------------- autosave and restore */

  // The tallies live in the presenting browser and nowhere else until Alt+R.
  // Each module that keeps any registers how to save and restore them, and
  // the lot goes to localStorage a second after every change: a crashed tab,
  // a flat battery or a closed window no longer loses the class.
  var stores = {};
  LP.persist = function (key, store) {
    stores[key] = store;
  };

  var AUTOSAVE_KEY = "livepoll-autosave:" + location.pathname;
  var exported = true; // nothing yet that Alt+R has not saved
  var saveTimer = null;
  var lastSaved = null;

  LP.dirty = function () {
    if (!LP.hosting()) return;
    exported = false;
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      autosave();
    }, 1000);
  };

  function snapshot() {
    var data = {};
    Object.keys(stores).forEach(function (key) {
      try {
        data[key] = stores[key].save();
      } catch (e) {
        console.warn("livepoll: could not save " + key, e);
      }
    });
    return {
      version: 1,
      saved: Date.now(),
      session: sessionId,
      responses: responseCount,
      exported: exported,
      data: data,
    };
  }

  function autosave() {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshot()));
      lastSaved = new Date();
      var status = document.getElementById("livepoll-autosave");
      if (status) status.textContent = "Autosaved " + lastSaved.toLocaleTimeString();
    } catch (e) {
      console.warn("livepoll: autosave failed", e);
      var warn = document.getElementById("livepoll-autosave");
      if (warn) warn.textContent = "Autosave failed — press Alt+R to save";
    }
  }

  // session.js calls this once session.json is downloaded.
  LP.markExported = function () {
    exported = true;
    if (LP.hosting()) autosave();
    else {
      try {
        var saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || "null");
        if (saved) {
          saved.exported = true;
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(saved));
        }
      } catch (e) {
        /* nothing to mark */
      }
    }
  };

  function readAutosave() {
    try {
      var saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || "null");
      if (!saved || saved.version !== 1 || !saved.data) return null;
      return saved;
    } catch (e) {
      return null;
    }
  }

  function restore(saved) {
    sessionId = saved.session || sessionId;
    responseCount = saved.responses || 0;
    // core first: the others look at which questions are closed
    var keys = Object.keys(saved.data).sort(function (a, b) {
      return (a === "core" ? 0 : 1) - (b === "core" ? 0 : 1);
    });
    keys.forEach(function (key) {
      if (!stores[key] || saved.data[key] == null) return;
      try {
        stores[key].restore(saved.data[key]);
      } catch (e) {
        console.warn("livepoll: could not restore " + key, e);
      }
    });
    exported = false;
    updatePills();
    LP.hud.refresh();
    LP.log("Restored " + responseCount + " responses from " + new Date(saved.saved).toLocaleString());
  }

  LP.persist("core", {
    save: function () {
      return { closed: closed, openedAt: openedAt };
    },
    restore: function (data) {
      closed = data.closed || {};
      openedAt = data.openedAt || {};
    },
  });

  // Offered once, on load, for results that never made it into a session.json.
  // Not in the speaker view's slide previews, which share this storage.
  function offerRestore() {
    if (/receiver/i.test(window.location.search)) return;
    var saved = readAutosave();
    if (!saved || saved.exported || !saved.responses) return;
    var bar = document.createElement("div");
    bar.id = "livepoll-restore";
    bar.setAttribute("role", "alertdialog");
    bar.innerHTML =
      '<span class="livepoll-restore-text"></span>' +
      '<button type="button" data-act="restore">Restore</button>' +
      '<button type="button" data-act="discard">Discard</button>';
    bar.querySelector(".livepoll-restore-text").textContent =
      "Unsaved live results from " +
      new Date(saved.saved).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) +
      " (" + saved.responses + (saved.responses === 1 ? " response" : " responses") + ").";
    bar.addEventListener("click", function (evt) {
      var act = evt.target.getAttribute && evt.target.getAttribute("data-act");
      if (!act) return;
      if (act === "restore") {
        restore(saved);
        lastRestored = saved;
      } else if (confirm("Discard these results for good?")) {
        try {
          localStorage.removeItem(AUTOSAVE_KEY);
        } catch (e) {
          /* already gone */
        }
      } else {
        return;
      }
      bar.parentNode.removeChild(bar);
    });
    bar.addEventListener("keydown", function (evt) {
      evt.stopPropagation();
    });
    document.body.appendChild(bar);
  }
  var lastRestored = null;

  // Restored before hosting started: save it under this session as soon as it
  // does, so a second crash finds it too.
  document.addEventListener("seminar", function () {
    if (lastRestored && LP.hosting()) {
      lastRestored = null;
      exported = false;
      autosave();
    }
  });

  // Leaving with results Alt+R has not saved gets the browser's own "leave
  // this page?" question. The autosave has them either way.
  window.addEventListener("beforeunload", function (event) {
    if (exported || !LP.hosting()) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      autosave();
    }
    event.preventDefault();
    event.returnValue = "";
  });

  /* ------------------------------------------------- presenter display */

  // What only the presenter should see — live counts, the timer, who is lost,
  // the top question — drawn in the "Live now" box of the Live poll tab and in
  // the speaker view (S), never on the projected slide. Modules add parts:
  // LP.hud.add(key, order, render) where render() returns HTML or "".
  var hudParts = [];
  var hudQueued = false;
  var speakerWindow = null;

  LP.hud = {
    add: function (key, order, render) {
      hudParts = hudParts.filter(function (p) { return p.key !== key; });
      hudParts.push({ key: key, order: order, render: render });
      hudParts.sort(function (a, b) { return a.order - b.order; });
      LP.hud.refresh();
    },
    refresh: function () {
      if (hudQueued) return;
      hudQueued = true;
      setTimeout(function () {
        hudQueued = false;
        drawHud();
      }, 150);
    },
  };

  function hudHtml() {
    var out = [];
    hudParts.forEach(function (part) {
      var html = "";
      try {
        html = part.render() || "";
      } catch (e) {
        console.warn("livepoll: HUD part " + part.key + " failed", e);
      }
      if (html) out.push('<div class="lp-hud-part" data-part="' + part.key + '">' + html + "</div>");
    });
    return out.join("");
  }

  function drawHud() {
    var html = hudHtml() || '<div class="lp-hud-part lp-hud-idle">Not hosting</div>';
    var box = document.getElementById("livepoll-live");
    if (box) box.innerHTML = html;
    drawSpeakerHud(html);
  }

  // The notes plugin opens the speaker view as about:blank and writes its page
  // into it, so it shares this origin and can be drawn into directly. The
  // window is caught as it is opened, or — after this page reloads — from the
  // heartbeat it keeps sending to reconnect.
  var nativeOpen = window.open;
  window.open = function (url, name) {
    var win = nativeOpen.apply(window, arguments);
    if (name === "reveal.js - Notes" && win) {
      speakerWindow = win;
      LP.hud.refresh();
    }
    return win;
  };

  window.addEventListener("message", function (event) {
    if (speakerWindow && !speakerWindow.closed) return;
    if (typeof event.data !== "string" || event.data.indexOf("reveal-notes") === -1) return;
    try {
      if (event.source && event.source.document && event.source.location.origin === location.origin) {
        speakerWindow = event.source;
        LP.hud.refresh();
      }
    } catch (e) {
      /* another origin's window: not ours to draw in */
    }
  });

  var SPEAKER_HUD_CSS =
    ".livepoll-hud{margin:10px 0 0;padding:8px 10px;border-radius:6px;background:rgba(0,0,0,.06);" +
    "font:14px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222}" +
    ".livepoll-hud .lp-hud-part{padding:3px 0}" +
    ".livepoll-hud .lp-hud-part+.lp-hud-part{border-top:1px solid rgba(0,0,0,.08)}" +
    ".livepoll-hud .lp-hud-title{font-weight:700}" +
    ".livepoll-hud .lp-hud-muted{opacity:.65}" +
    ".livepoll-hud .lp-hud-alert{color:#b42318;font-weight:700}" +
    ".livepoll-hud .lp-hud-big{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}" +
    ".livepoll-hud ol{margin:2px 0 0 18px;padding:0}";

  function drawSpeakerHud(html) {
    if (!speakerWindow || speakerWindow.closed) return;
    var doc;
    try {
      doc = speakerWindow.document;
    } catch (e) {
      return;
    }
    var controls = doc && doc.getElementById("speaker-controls");
    if (!controls) {
      // still writing itself; try again shortly
      setTimeout(LP.hud.refresh, 500);
      return;
    }
    var hud = doc.getElementById("livepoll-hud");
    if (!hud) {
      var style = doc.createElement("style");
      style.textContent = SPEAKER_HUD_CSS;
      doc.head.appendChild(style);
      hud = doc.createElement("div");
      hud.id = "livepoll-hud";
      hud.className = "livepoll-hud";
      var notes = controls.querySelector(".speaker-controls-notes");
      controls.insertBefore(hud, notes || null);
    }
    hud.innerHTML = html;
  }

  // Timers count down between events.
  setInterval(function () {
    if (LP.hosting() || speakerWindow) drawHud();
  }, 1000);

  /* ----------------------------------------------- panel sections, kinds */

  // A module's own block of controls in the Live poll tab (or the floating
  // panel): wherever the built-in ones are by the time it asks.
  LP.addSection = function (id, title, html) {
    var section = document.createElement("div");
    section.className = "livepoll-section";
    section.id = id;
    section.innerHTML = "<h3>" + title + "</h3>" + html;
    var slot = inMenu && document.getElementById("livepoll-menu-slot");
    var session = document.getElementById("livepoll-session");
    var parent = slot || document.getElementById("livepoll-panel");
    // keep the Session block last
    if (session && session.parentNode === parent) parent.insertBefore(section, session);
    else parent.appendChild(section);
    return section;
  };

  // Which kind of question an id is, and what each kind knows how to do for
  // the presenter's buttons. Modules register: LP.kinds.estimate = { reset }.
  LP.kinds = {};
  LP.kindOf = function (id) {
    var cfg = deckConfig();
    var tables = {
      poll: cfg.polls, wordcloud: cfg.clouds, likert: cfg.likerts,
      estimate: cfg.estimates, rank: cfg.ranks, hotspot: cfg.hotspots, sketch: cfg.sketches,
    };
    for (var kind in tables) if (tables[kind] && tables[kind][id]) return kind;
    return null;
  };

  // The first lines of the presenter display: what is open and who answered.
  LP.hud.add("active", 10, function () {
    if (!LP.hosting()) return "";
    var connected = LP.connectedCount();
    var id = currentActivePoll;
    if (!id) {
      return '<span class="lp-hud-muted">No question open · ' + connected + " connected</span>";
    }
    var kind = LP.kindOf(id);
    var count = kind && LP.kinds[kind] && LP.kinds[kind].count ? LP.kinds[kind].count(id) : null;
    var out =
      '<div class="lp-hud-title">' + LP.escape(id) +
      ' <span class="lp-hud-muted">' + (LP.isOpen(id) ? "open" : "closed") + "</span></div>";
    if (count) {
      var people = count.people !== undefined ? count.people : count.n;
      out +=
        '<div><span class="lp-hud-big">' + count.n + "</span> " + LP.escape(count.label) +
        (connected
          ? ' <span class="lp-hud-muted">· ' + connected + " connected, " +
            Math.min(100, Math.round((people / connected) * 100)) + "% answered</span>"
          : "") +
        "</div>";
    }
    return out;
  });

  // A participant's page asks for the current state when it joins; answer it
  // exactly as a new arrival is answered, by every module's `welcome`.
  LP.sync = function (userId) {
    if (!userId || !LP.hosting()) return;
    var event = new CustomEvent("welcome");
    event.content = { user: { id: userId } };
    document.dispatchEvent(event);
  };

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
      '<div class="livepoll-section" id="livepoll-live-section">' +
      "  <h3>Live now</h3>" +
      '  <div id="livepoll-live" class="livepoll-hud-box"></div>' +
      "</div>" +
      '<div class="livepoll-section" id="pollControl">' +
      "  <h3>Poll control</h3>" +
      "  <p>Active poll: <span id='activePollDisplay'>None</span></p>" +
      '  <select id="pollSelector"><option value="">-- Select Poll --</option></select>' +
      '  <button id="activatePoll" type="button">Activate</button>' +
      '  <button id="deactivatePoll" type="button">Deactivate</button>' +
      '  <div class="livepoll-row">' +
      '    <button id="closePoll" type="button" title="Stop taking answers; the question stays up">Close voting</button>' +
      '    <button id="reopenPoll" type="button">Re-open</button>' +
      '    <button id="newRound" type="button" title="Vote again on the same question (peer instruction)">New round</button>' +
      '    <button id="resetPoll" type="button">Reset results</button>' +
      "  </div>" +
      "  <p class='livepoll-hint'>The buttons act on the selected question, or the active one. Opening a question's slide activates it. Shift+Q shows the QR code full screen.</p>" +
      "</div>" +
      '<div class="livepoll-section" id="livepoll-session">' +
      "  <h3>Session</h3>" +
      '  <button id="livepoll-download" type="button" title="Alt+R">Download session.json</button>' +
      '  <button id="livepoll-csv" type="button">Download CSV</button>' +
      '  <p class="livepoll-hint" id="livepoll-autosave">Results are autosaved in this browser while you host.</p>' +
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

  // Every question element on the slides, of whatever kind, by its id.
  var QUESTION_SELECTOR =
    ".poll[data-poll], .wordcloud[data-wordcloud], .likert[data-likert], " +
    ".lp-estimate[data-estimate], .lp-rank[data-rank], .lp-hotspot[data-hotspot], .lp-sketch[data-sketch]";

  function questionId(el) {
    return (
      el.getAttribute("data-poll") ||
      el.getAttribute("data-wordcloud") ||
      el.getAttribute("data-likert") ||
      el.getAttribute("data-estimate") ||
      el.getAttribute("data-rank") ||
      el.getAttribute("data-hotspot") ||
      el.getAttribute("data-sketch")
    );
  }
  LP.questionId = questionId;

  function initPollControls() {
    var pollSelector = document.getElementById("pollSelector");
    var items = document.querySelectorAll(QUESTION_SELECTOR);
    var listed = {};

    for (var i = 0; i < items.length; i++) {
      var itemId = questionId(items[i]);
      if (!itemId || listed[itemId]) continue;
      listed[itemId] = true;
      var option = document.createElement("option");
      option.value = itemId;
      option.textContent = itemId;
      pollSelector.appendChild(option);
    }

    function target(needHost) {
      var id = pollSelector.value || currentActivePoll;
      if (!id) {
        alert("Select a question first");
        return null;
      }
      if (needHost && !LP.hosting()) {
        alert("You must be hosting the seminar for that");
        return null;
      }
      return id;
    }

    document.getElementById("closePoll").addEventListener("click", function () {
      var id = target(true);
      if (id) LP.close(id);
    });
    document.getElementById("reopenPoll").addEventListener("click", function () {
      var id = target(true);
      if (id) LP.reopen(id);
    });
    document.getElementById("newRound").addEventListener("click", function () {
      var id = target(true);
      if (!id) return;
      if (LP.kindOf(id) !== "poll" || !LP.newRound) {
        alert("Only a multiple-choice poll can have rounds");
        return;
      }
      LP.newRound(id);
    });
    document.getElementById("resetPoll").addEventListener("click", function () {
      var id = target(true);
      if (!id) return;
      if (!confirm('Remove every answer given to "' + id + '"?')) return;
      var kind = LP.kindOf(id);
      if (kind && LP.kinds[kind] && LP.kinds[kind].reset) {
        LP.kinds[kind].reset(id);
        LP.log("Reset: " + id);
        LP.dirty();
      }
    });
    document.getElementById("livepoll-download").addEventListener("click", function () {
      if (window.plateSession) window.plateSession.export();
    });
    document.getElementById("livepoll-csv").addEventListener("click", function () {
      if (window.plateSession) window.plateSession.exportCsv();
    });

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
      session: LP.sessionId(),
      round: LP.roundOf ? LP.roundOf(pollId) : 1,
    };
    document.dispatchEvent(message);

    currentActivePoll = pollId;
    if (!openedAt[pollId]) openedAt[pollId] = Date.now();
    var display = document.getElementById("activePollDisplay");
    if (display) display.textContent = pollId;
    var selector = document.getElementById("pollSelector");
    if (selector) selector.value = pollId;
    window.seminarStatusLogger("Activated poll: " + pollId);
    updatePills();
    activeChanged();
    LP.dirty();
    return true;
  }

  LP.active = function () {
    return currentActivePoll;
  };
  LP.activate = activatePoll;
  LP.deactivate = deactivatePolls;

  function activeChanged() {
    document.dispatchEvent(new CustomEvent("livepoll-activated", { detail: { id: currentActivePoll } }));
    LP.hud.refresh();
  }

  // A deck following the host learns the active question from the host's
  // announcements, so its LIVE / CLOSED pills are right too.
  LP.on("poll-control", function (content, event) {
    if (LP.hosting() || !LP.trusted(event)) return;
    if (content.type === "activate-poll") {
      if (currentActivePoll === content.pollId) return;
      currentActivePoll = content.pollId;
    } else if (content.type === "deactivate-poll") {
      currentActivePoll = null;
    } else {
      return;
    }
    updatePills();
    activeChanged();
  });

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
    activeChanged();
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

    // Measure in the font the words are drawn in: the box's own. Measuring in
    // the page body's font sized the words for one font and drew them in
    // another, and they ran into each other. Under a theme that sets its font on
    // the slides rather than on <body> (plate: body falls back to Times, slides
    // are Inter), that was every classic cloud; the embedded layout sets its
    // own font on the box too.
    var themed = box.classList.contains("lp-cloud");
    var fontFamily = window.getComputedStyle(box).fontFamily || "sans-serif";
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

  // How many words each participant has sent per cloud, host only: the page
  // stops at max-words, and now so does the host, for anyone who skips the page.
  var cloudSenders = {}; // cloudId -> { voter key -> words sent }

  function acceptWord(id, word, who, t) {
    addWords(id, [word]);
    renderCloud(id);
    broadcastCounts(id);
    LP.response({ kind: "wordcloud", id: id, who: who, value: word, t: t });
  }

  /* Words held for approval, host only: those the filter flags (filter.js)
   * and, with `livepoll: wordcloud: moderated`, every word. Counted against
   * the sender's max-words like any other, so holding one is no invitation to
   * try again. The presenter's panel lists them, identical words together. */
  var cloudHeld = []; // [{ cloud, word, who, t, flagged }]
  var heldPanel = null;

  function heldGroups() {
    var groups = [];
    var byKey = {};
    cloudHeld.forEach(function (h) {
      var key = h.cloud + "|" + h.word.toLowerCase();
      if (!byKey[key]) {
        byKey[key] = { key: key, cloud: h.cloud, word: h.word, n: 0, flagged: false };
        groups.push(byKey[key]);
      }
      byKey[key].n++;
      byKey[key].flagged = byKey[key].flagged || h.flagged;
    });
    return groups;
  }

  function decideHeld(key, approve) {
    var keep = [];
    var touched = {};
    cloudHeld.forEach(function (h) {
      var match = key === "*unflagged" ? !h.flagged : h.cloud + "|" + h.word.toLowerCase() === key;
      if (!match) return keep.push(h);
      if (approve) {
        addWords(h.cloud, [h.word]);
        touched[h.cloud] = true;
        LP.response({ kind: "wordcloud", id: h.cloud, who: h.who, value: h.word, t: h.t });
      }
    });
    cloudHeld = keep;
    Object.keys(touched).forEach(function (id) {
      renderCloud(id);
      broadcastCounts(id);
    });
    drawHeld();
    LP.dirty();
  }

  function drawHeld() {
    LP.hud.refresh();
    if (!heldPanel) return;
    var groups = heldGroups();
    var several = Object.keys(deckConfig().clouds || {}).length > 1;
    var unflagged = cloudHeld.filter(function (h) { return !h.flagged; }).length;
    heldPanel.querySelector("h3").textContent = "Words to approve" + (cloudHeld.length ? " (" + cloudHeld.length + ")" : "");
    heldPanel.querySelector(".livepoll-cloud-held").innerHTML = groups.length
      ? groups
          .map(function (g) {
            return (
              '<div class="livepoll-qa-item" data-key="' + LP.escape(g.key) + '">' +
              '<span class="livepoll-qa-votes">' + (g.flagged ? '<span title="Matched the word filter">⚠</span>' : "") +
              (g.n > 1 ? "×" + g.n : "") + "</span>" +
              '<span class="livepoll-qa-text">' + LP.escape(g.word) +
              (several ? ' <span class="livepoll-hint">(' + LP.escape(g.cloud) + ")</span>" : "") + "</span>" +
              '<span class="livepoll-qa-actions"><button type="button" data-act="approve" title="Add to the cloud">Approve</button>' +
              '<button type="button" data-act="reject" title="Leave it out">✕</button></span></div>'
            );
          })
          .join("") +
          (unflagged > 1 ? '<button type="button" data-act="approve-unflagged">Approve all not flagged (' + unflagged + ")</button>" : "")
      : '<p class="livepoll-hint">Nothing waiting.</p>';
  }

  // called once the panel exists (the DOMContentLoaded handler at the end)
  function initHeldPanel() {
    if (!Object.keys(deckConfig().clouds || {}).length) return;
    if (!LP.filter.on() && deckConfig().wordcloud !== "moderated") return;
    heldPanel = LP.addSection(
      "livepoll-cloud-moderation",
      "Words to approve",
      '<div class="livepoll-cloud-held"></div><p class="livepoll-hint">' +
        (deckConfig().wordcloud === "moderated"
          ? "Every word waits for your approval before it joins the cloud. "
          : "Words the filter flags (⚠) wait here instead of joining the cloud. ") +
        "Nobody else sees them unless you approve them.</p>"
    );
    heldPanel.addEventListener("click", function (evt) {
      var act = evt.target.getAttribute && evt.target.getAttribute("data-act");
      if (!act) return;
      if (!LP.hosting()) {
        alert("You must be hosting the seminar for that");
        return;
      }
      if (act === "approve-unflagged") return decideHeld("*unflagged", true);
      var item = evt.target.closest(".livepoll-qa-item");
      if (item) decideHeld(item.getAttribute("data-key"), act === "approve");
    });
    drawHeld();
  }

  LP.hud.add("cloud-held", 41, function () {
    if (!LP.hosting() || !cloudHeld.length) return "";
    return '<div class="lp-hud-title"><span class="lp-hud-alert">' + cloudHeld.length +
      (cloudHeld.length === 1 ? " word" : " words") + " to approve</span></div>";
  });

  function cloudAllowance(id, event, content) {
    var def = (deckConfig().clouds || {})[id];
    var max = (def && def.maxWords) || 3;
    var who = LP.who(event, content);
    if (!who) return true;
    var sent = cloudSenders[id] || (cloudSenders[id] = {});
    if ((sent[who] || 0) >= max) return false;
    sent[who] = (sent[who] || 0) + 1;
    return true;
  }

  document.addEventListener("received", function (event) {
    var content = event.content;
    if (!content || content.sender !== "wordcloud-plugin") return;

    if (content.type === "word") {
      // only the host keeps the tally, exactly as the poll plugin does
      if (!LP.hosting()) return;
      if (!(deckConfig().clouds || {})[content.cloud] || !LP.isOpen(content.cloud)) return;
      var words = (content.words || [content.word]).filter(function (w) {
        return typeof w === "string" && w.trim() && w.length <= 40;
      });
      if (!words.length || !cloudAllowance(content.cloud, event, content)) return;
      var word = words[0].trim();
      var who = LP.who(event, content);
      var flagged = LP.filter.flags(word);
      // held back, unseen by anyone but the presenter, until approved
      if (flagged || deckConfig().wordcloud === "moderated") {
        cloudHeld.push({ cloud: content.cloud, word: word, who: who, t: Date.now(), flagged: flagged });
        drawHeld();
        LP.dirty();
        return;
      }
      acceptWord(content.cloud, word, who, Date.now());
    } else if (content.type === "counts") {
      if (!LP.trusted(event)) return;
      cloudCounts[content.cloud] = content.counts || {};
      renderCloud(content.cloud);
    } else if (content.type === "clear") {
      if (!LP.trusted(event)) return;
      cloudCounts[content.cloud] = {};
      renderCloud(content.cloud);
    }
  });

  LP.kinds.wordcloud = {
    reset: function (id) {
      delete cloudSenders[id];
      cloudHeld = cloudHeld.filter(function (h) { return h.cloud !== id; });
      drawHeld();
      clearCloud(id);
    },
    count: function (id) {
      var people = Object.keys(cloudSenders[id] || {}).length;
      var words = 0;
      var counts = cloudCounts[id] || {};
      for (var w in counts) words += counts[w];
      return { n: words, label: "words from " + people + (people === 1 ? " person" : " people"), people: people };
    },
  };

  LP.persist("clouds", {
    save: function () {
      return { counts: cloudCounts, senders: cloudSenders, held: cloudHeld };
    },
    restore: function (data) {
      cloudSenders = data.senders || {};
      cloudHeld = data.held || [];
      drawHeld();
      Object.keys(data.counts || {}).forEach(function (id) {
        // through the same message a live session uses, so session.js and
        // every drawing of the cloud see it
        var event = new CustomEvent("received");
        event.content = { sender: "wordcloud-plugin", type: "counts", cloud: id, counts: data.counts[id] };
        document.dispatchEvent(event);
      });
    },
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

  function validPoint(def, p) {
    return typeof p === "number" && p >= 0 && p < def.labels.length && p === Math.floor(p);
  }

  function addLikertAnswer(id, answers, event, content) {
    var def = likertDef(id);
    if (!def || !Array.isArray(answers) || !LP.isOpen(id)) return false;
    // nothing usable in it: not worth a place in the count
    if (!def.statements.some(function (_, s) { return validPoint(def, answers[s]); })) return false;
    var state = likertTally[id] || (likertTally[id] = { counts: emptyCounts(def), voters: 0 });
    var voters = likertAnswers[id] || (likertAnswers[id] = {});
    if (!LP.claim(voters, event, content)) {
      LP.refuse(event, id); // already answered: a reload, not a person
      return false;
    }
    for (var s = 0; s < def.statements.length; s++) {
      if (validPoint(def, answers[s])) state.counts[s][answers[s]]++;
    }
    state.voters++;
    LP.response({ kind: "likert", id: id, who: LP.who(event, content), value: answers.slice(0, def.statements.length) });
    return true;
  }

  LP.kinds.likert = {
    reset: function (id) {
      var def = likertDef(id);
      if (!def) return;
      likertTally[id] = { counts: emptyCounts(def), voters: 0 };
      likertAnswers[id] = {};
      likertState[id] = { counts: likertTally[id].counts, voters: 0 };
      renderLikert(id);
      broadcastLikert(id);
    },
    count: function (id) {
      return { n: (likertTally[id] || {}).voters || 0, label: "responses" };
    },
  };

  LP.persist("likerts", {
    save: function () {
      return { tally: likertTally, answers: likertAnswers };
    },
    restore: function (data) {
      likertAnswers = data.answers || {};
      likertTally = data.tally || {};
      Object.keys(likertTally).forEach(function (id) {
        var event = new CustomEvent("received");
        event.content = {
          sender: "likert-plugin", type: "counts", likert: id,
          counts: likertTally[id].counts, voters: likertTally[id].voters,
        };
        document.dispatchEvent(event);
      });
    },
  });

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
      if (!LP.hosting()) return;
      if (addLikertAnswer(content.likert, content.answers, event, content)) {
        var tally = likertTally[content.likert];
        likertState[content.likert] = { counts: tally.counts, voters: tally.voters };
        renderLikert(content.likert);
        broadcastLikert(content.likert);
      }
    } else if (content.type === "counts") {
      if (!LP.trusted(event)) return;
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
        if (LP.hosting()) return; // the presenting deck does not answer (see poll.js)
        if (!LP.connected()) {
          alert("You are currently not connected to the live poll. Your answer is ignored.");
          return;
        }
        LP.toHost({
          sender: "likert-plugin",
          type: "answer",
          likert: id,
          answers: answers.slice(),
        });
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
    var panels = slide.querySelectorAll(".livepoll-question");
    for (var i = 0; i < panels.length; i++) {
      if (questionId(panels[i]) === pollId) return panels[i];
    }
    return null;
  }

  // Bars are scaled to the leading option, the percentage is of all votes —
  // or, where a poll takes several choices, of the people who answered, since
  // the votes then add up to more than everyone.
  //
  // From a second round on (peer instruction: vote, discuss, vote again) both
  // rounds are drawn as shares on one scale, the earlier one as a marker on
  // the track, so the shift is what you see.
  function shares(rows, votes, voters, multi) {
    var total = 0;
    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      var n = votes[rows[i].getAttribute("data-value")] || 0;
      total += n;
      if (n > max) max = n;
    }
    return { total: total, max: max, base: multi ? voters || total : total };
  }

  function updatePanelBars(panel, votes, info) {
    info = info || {};
    var multi = panel.getAttribute("data-multi") === "true";
    var rows = panel.querySelectorAll(".lp-row[data-value]");
    var now = shares(rows, votes, info.voters, multi);
    var history = info.history || [];
    var prev = history.length ? history[history.length - 1] : null;
    var before = prev ? shares(rows, prev.votes || {}, prev.voters, multi) : null;
    panel.classList.toggle("lp-rounds", !!prev);
    var badge = panel.querySelector(".lp-round-badge");
    if (badge) badge.textContent = prev ? "Round " + (history.length + 1) : "";

    for (var j = 0; j < rows.length; j++) {
      var value = rows[j].getAttribute("data-value");
      var count = votes[value] || 0;
      var share = now.base > 0 ? count / now.base : 0;
      var width = prev ? share : now.max > 0 ? count / now.max : 0;
      rows[j].querySelector(".lp-fill").style.width = (width * 100).toFixed(2) + "%";
      rows[j].querySelector(".lp-n").textContent = count;
      rows[j].querySelector(".lp-pct").textContent = Math.round(share * 100) + "%";
      rows[j].classList.toggle("lp-lead", now.max > 0 && count === now.max);

      var marker = rows[j].querySelector(".lp-prev");
      var was = rows[j].querySelector(".lp-was");
      if (prev) {
        var then = before.base > 0 ? (prev.votes[value] || 0) / before.base : 0;
        if (!marker) {
          marker = document.createElement("span");
          marker.className = "lp-prev";
          rows[j].querySelector(".lp-track").appendChild(marker);
        }
        if (!was) {
          was = document.createElement("span");
          was.className = "lp-was";
          rows[j].querySelector(".lp-label").appendChild(was);
        }
        marker.style.left = (then * 100).toFixed(2) + "%";
        was.textContent = "round " + history.length + ": " + Math.round(then * 100) + "%";
      } else {
        if (marker) marker.parentNode.removeChild(marker);
        if (was) was.parentNode.removeChild(was);
      }
    }
  }

  // The classic chart gets the earlier round as a second, paler set of bars.
  function syncChartRounds(canvas, history) {
    var chart = canvas.chart;
    if (!chart) return;
    var prev = history && history.length ? history[history.length - 1] : null;
    var datasets = chart.data.datasets;
    if (!prev) {
      if (datasets.length > 1) {
        datasets.length = 1;
        chart.options.plugins.legend.display = false;
        chart.update();
      }
      return;
    }
    var pollId = canvas.getAttribute("data-poll");
    var poll = (deckConfig().polls || {})[pollId];
    if (!poll) return;
    var data = poll.options.map(function (opt) {
      return prev.votes[opt.value] || 0;
    });
    datasets[0].label = "Round " + (history.length + 1);
    if (datasets.length < 2) {
      datasets.push({
        label: "Round " + history.length,
        data: data,
        backgroundColor: "rgba(150,150,150,0.45)",
        borderColor: "rgba(110,110,110,0.8)",
        borderWidth: 2,
      });
    } else {
      datasets[1].label = "Round " + history.length;
      datasets[1].data = data;
    }
    chart.options.plugins.legend.display = true;
    chart.update();
  }

  document.addEventListener("received", function (event) {
    var content = event.content;
    if (!content || content.sender !== "poll-plugin") return;
    if (content.type !== "results" || !content.votes || !LP.trusted(event)) return;
    var panels = panelsFor(content.poll);
    for (var i = 0; i < panels.length; i++) {
      updatePanelBars(panels[i], content.votes, content);
    }
    var charts = document.querySelectorAll('canvas[data-chart][data-poll="' + content.poll + '"]');
    for (var k = 0; k < charts.length; k++) syncChartRounds(charts[k], content.history);
  });

  // Results are hidden (results="hidden") until the answer is given or, for a
  // poll without one, until its results fragment is shown. The answer counts
  // as given on the same terms as the green bar in the classic chart: reveal's
  // own `visible` class *and* the presenter having actually stepped to it.
  function syncPanel(panel) {
    var pollId = questionId(panel);
    var answer = panel.querySelector(".poll-answer");
    var given =
      !!answer &&
      answer.classList.contains("visible") &&
      revealedAnswers[pollId] !== undefined;
    var correct = given ? LP.correctSet(answer.getAttribute("data-correct")) : [];

    var rows = panel.querySelectorAll(".lp-row[data-value]");
    for (var i = 0; i < rows.length; i++) {
      var right = correct.indexOf(rows[i].getAttribute("data-value")) !== -1;
      rows[i].classList.toggle("lp-correct", given && right);
      rows[i].classList.toggle("lp-dim", given && !right);
    }

    var reveal = panel.querySelector(".lp-reveal");
    var shown = !!reveal && reveal.classList.contains("visible");
    var hidden = panel.getAttribute("data-results") === "hidden" && !given && !shown;
    panel.classList.toggle("lp-results-hidden", hidden);
  }

  function syncAllPanels() {
    var panels = document.querySelectorAll(".livepoll-question[data-results]");
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
  // LIVE while this question is the active poll and open, CLOSED otherwise.
  // Beside it, how many are in the room and what share of them has answered.
  var PILL_TEXT = { live: "LIVE", closed: "CLOSED", offline: "OFFLINE" };

  function updatePills() {
    var online = LP.connected();
    var connected = LP.connectedCount();
    var panels = document.querySelectorAll(".livepoll-question");
    for (var i = 0; i < panels.length; i++) {
      var id = questionId(panels[i]);
      var board = panels[i].classList.contains("lp-qa-q");
      var state = !online ? "offline" : board || (id === currentActivePoll && LP.isOpen(id)) ? "live" : "closed";
      var pill = panels[i].querySelector(".lp-pill");
      if (pill && pill.getAttribute("data-state") !== state) {
        pill.setAttribute("data-state", state);
        pill.textContent = PILL_TEXT[state];
      }
      var joined = panels[i].querySelector(".lp-joined");
      if (joined) {
        var text = "";
        if (online && connected > 0) {
          var counter = panels[i].querySelector(".lp-count-n");
          var answered = counter ? Number(counter.textContent) || 0 : 0;
          text = connected + " connected";
          // words and questions are not people, so these get no rate
          if (!panels[i].classList.contains("lp-wordcloud") && !board && answered > 0) {
            text += " · " + Math.min(100, Math.round((answered / connected) * 100)) + "%";
          }
        }
        if (joined.textContent !== text) joined.textContent = text;
      }
    }
  }

  setInterval(updatePills, 1000);

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

  // What a slide is about: poll buttons, a results chart, a word cloud, or
  // any of the other question kinds.
  function pollOnSlide(slide) {
    if (!slide || !slide.querySelector) return null;
    var el = slide.querySelector(
      QUESTION_SELECTOR + ", canvas[data-chart][data-poll], canvas[data-chart][data-likert]"
    );
    return el ? questionId(el) : null;
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

    // the other kinds measure and draw themselves
    document.dispatchEvent(new CustomEvent("livepoll-slide", { detail: { slide: slide } }));
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
  // Announcements to that one participant: only a host can make them, which
  // is what lets the phone believe them (see seminar.js, announceTo).
  document.addEventListener("welcome", function (event) {
    if (!LP.hosting() || !currentActivePoll || !event.content || !event.content.user) return;
    var user = event.content.user.id;
    LP.sendTo(user, {
      sender: "poll-control",
      type: "activate-poll",
      pollId: currentActivePoll,
      session: LP.sessionId(),
      round: LP.roundOf ? LP.roundOf(currentActivePoll) : 1,
    });

    if (likertState[currentActivePoll]) {
      LP.sendTo(user, {
        sender: "likert-plugin",
        type: "counts",
        likert: currentActivePoll,
        counts: likertState[currentActivePoll].counts,
        voters: likertState[currentActivePoll].voters,
      });
    }

    if (cloudCounts[currentActivePoll]) {
      LP.sendTo(user, {
        sender: "wordcloud-plugin",
        type: "counts",
        cloud: currentActivePoll,
        counts: cloudCounts[currentActivePoll],
      });
    }

    if (!LP.isOpen(currentActivePoll)) {
      LP.sendTo(user, { sender: "poll-control", type: "close-poll", pollId: currentActivePoll });
    }

    if (revealedAnswers[currentActivePoll] !== undefined) {
      LP.sendTo(user, {
        sender: "poll-control",
        type: "reveal-answer",
        pollId: currentActivePoll,
        correct: revealedAnswers[currentActivePoll],
      });
    }
  });

  // A poll page asks for the current state once it has joined (and again
  // after a reconnect). Answer it alone, as a new arrival is answered.
  document.addEventListener("received", function (event) {
    var content = event.content;
    if (!content || content.sender !== "poll-page" || content.type !== "request-active-poll") return;
    LP.sync(LP.socketOf(event));
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

    var correct = LP.correctSet(correctValue);
    var next = correct.length
      ? poll.options.map(function (opt) {
          return correct.indexOf(opt.value) !== -1 ? "#2e9e4f" : dataset._livepollBase;
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

  // For the kinds that draw their own answer (an estimate's line, a hotspot's
  // circle) and for scoring: `livepoll-answer` with { id, shown }.
  LP.answerShown = function (id) {
    return revealedAnswers[id] !== undefined;
  };

  function answerChanged(id, shown) {
    document.dispatchEvent(new CustomEvent("livepoll-answer", { detail: { id: id, shown: shown, correct: revealedAnswers[id] } }));
    LP.hud.refresh();
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
      send({
        sender: "poll-plugin", type: "results", poll: pollIds[i], votes: poll.votes,
        voters: poll.voters, history: poll.history || [],
      });
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
    // estimates, rankings, hotspots, questions: each module replays its own
    document.dispatchEvent(new CustomEvent("livepoll-replay", { detail: recorded }));
  }

  function initRevealHooks() {
    whenRevealReady(function (Reveal) {
      setTimeout(replayRecorded, 0); // after every other `ready` listener
      // after the replay: restored results go on top of recorded ones
      setTimeout(offerRestore, 50);
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

      // A round step (rounds="2"): stepping to it opens the next round, once.
      // Stepping back does not take it back; the votes stay.
      Reveal.on("fragmentshown", function (event) {
        var fragment = event.fragment;
        if (!fragment || !fragment.classList || !fragment.classList.contains("lp-round")) return;
        if (!fragment.classList.contains("visible") || !LP.hosting() || !LP.newRound) return;
        var id = fragment.getAttribute("data-poll");
        var round = Number(fragment.getAttribute("data-round"));
        if (LP.roundOf(id) < round) LP.newRound(id);
      });

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
        answerChanged(pollId, true);
      });

      Reveal.on("fragmenthidden", function (event) {
        withdrawHiddenAnswers();
        if (isAnswerFragment(event.fragment)) syncFragment(event.fragment);
      });
      // Going back a slide hides the fragments of the one you left without any
      // event: reveal resets a slide ahead of you silently.
      Reveal.on("slidechanged", withdrawHiddenAnswers);
    });
  }

  // An answer counts as given while any copy of it is showing (the same answer
  // may be written on a second slide). Once none is — stepped back, or gone
  // back a slide after advancing too far — it is taken back everywhere: the
  // phones drop it, and late joiners are no longer told it.
  function withdrawHiddenAnswers() {
    Object.keys(revealedAnswers).forEach(function (pollId) {
      var copies = answerFragments(pollId);
      for (var i = 0; i < copies.length; i++) {
        if (copies[i].classList.contains("visible")) return;
      }
      delete revealedAnswers[pollId];
      if (LP.hosting()) {
        LP.broadcast({ sender: "poll-control", type: "hide-answer", pollId: pollId });
      }
      syncAnswerHighlight(pollId);
      answerChanged(pollId, false);
    });
  }

  /* --------------------------------------- the speaker view's previews */

  // The speaker view (S) shows the slides in two frames that are copies of
  // this deck (?receiver), each with its own Live poll tab. A copy must never
  // host: it does not broadcast, so logging in there opened the room, let the
  // phones join, and then no poll ever reached them. Instead its tab works the
  // presentation window's: each button press and field is passed over, and
  // what the real panel shows (status log, live display, questions, players)
  // is copied back once a second.
  var isReceiver = /receiver/i.test(window.location.search);

  // speaker view frame -> speaker view window -> the window that opened it
  function presentationWindow() {
    try {
      var main = window.parent !== window && window.parent.opener;
      if (main && main !== window && main.Livepoll && main.document) return main;
    } catch (e) {
      /* not ours to reach */
    }
    return null;
  }

  // The same element in the other window's panel: by id, else by position
  // among its section's elements of that kind.
  function counterpart(el, mainDoc) {
    if (el.id) return mainDoc.getElementById(el.id);
    var section = el.closest(".livepoll-section");
    var other = section && section.id && mainDoc.getElementById(section.id);
    if (!other) return null;
    var tag = el.tagName.toLowerCase();
    var mine = Array.prototype.indexOf.call(section.querySelectorAll(tag), el);
    return other.querySelectorAll(tag)[mine] || null;
  }

  var MIRRORED = [
    "#livepoll-live", "#activePollDisplay", "#livepoll-autosave",
    ".livepoll-qa-list", ".livepoll-qa-hidden", ".livepoll-quiz-list", ".livepoll-cloud-held",
    ".livepoll-signals-now", ".livepoll-section h3",
  ];

  function mirrorPanel() {
    var main = presentationWindow();
    if (!main) return;
    var mainDoc = main.document;
    MIRRORED.forEach(function (selector) {
      var mine = document.querySelectorAll(selector);
      var theirs = mainDoc.querySelectorAll(selector);
      for (var i = 0; i < mine.length && i < theirs.length; i++) {
        if (mine[i].innerHTML !== theirs[i].innerHTML) mine[i].innerHTML = theirs[i].innerHTML;
      }
    });
    var log = document.getElementById("logger");
    var mainLog = mainDoc.getElementById("logger");
    if (log && mainLog && log.value !== mainLog.value) {
      log.value = mainLog.value;
      log.scrollTop = log.scrollHeight;
    }
    var selector = document.getElementById("pollSelector");
    var mainSelector = mainDoc.getElementById("pollSelector");
    if (selector && mainSelector && document.activeElement !== selector) selector.value = mainSelector.value;
  }

  function initReceiverProxy() {
    var note = document.createElement("p");
    note.className = "livepoll-hint";
    note.textContent =
      "This is the speaker view: these controls work the presentation window, which is the one that hosts.";
    var broadcast = document.getElementById("broadcast");
    if (broadcast) broadcast.insertBefore(note, broadcast.querySelector("form"));

    document.addEventListener(
      "click",
      function (evt) {
        var button = evt.target.closest && evt.target.closest("button");
        if (!button || !button.closest(".livepoll-section")) return;
        evt.preventDefault();
        evt.stopImmediatePropagation();
        var main = presentationWindow();
        if (!main) {
          LP.log("Can't reach the presentation window: start the seminar there.");
          return;
        }
        // the fields first (user name, password, the selected question)
        var section = button.closest(".livepoll-section");
        section.querySelectorAll("input, select, textarea").forEach(function (field) {
          var other = counterpart(field, main.document);
          if (other) other.value = field.value;
        });
        var target = counterpart(button, main.document);
        if (target) target.click();
        setTimeout(mirrorPanel, 300);
      },
      true
    );

    // The presenter's shortcuts belong to the presentation window too.
    document.addEventListener(
      "keydown",
      function (evt) {
        var tag = (evt.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        var timer = evt.key === "T" && evt.shiftKey && !evt.altKey && !evt.ctrlKey && !evt.metaKey;
        var save =
          evt.altKey && !evt.ctrlKey && !evt.metaKey &&
          (evt.code === "KeyR" || (evt.key || "").toLowerCase() === "r");
        if (!timer && !save) return;
        var main = presentationWindow();
        if (!main) return;
        evt.preventDefault();
        evt.stopImmediatePropagation();
        main.document.dispatchEvent(
          new main.KeyboardEvent("keydown", {
            key: evt.key, code: evt.code, shiftKey: evt.shiftKey, altKey: evt.altKey,
            bubbles: true, cancelable: true,
          })
        );
      },
      true
    );

    setInterval(mirrorPanel, 1000);
    mirrorPanel();
  }

  /* ------------------------------------------------------------- start up */

  document.addEventListener("DOMContentLoaded", function () {
    buildPanel();
    if (isReceiver) initReceiverProxy();
    initSeminarControls();
    initPollControls();
    moveIntoMenu();
    initHeldPanel();
    renderQRCodes();
    renderPanelQRCodes();
    initClassicLikerts();
    syncAllPanels(); // results="hidden" panels start hidden
    updatePills();
    initRevealHooks();
    LP.hud.refresh();

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
