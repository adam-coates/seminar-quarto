/*****************************************************************
** livepoll — audience questions.
**
** The poll page has a Questions tab, open all session: anyone can ask, and
** upvote what others asked. The host keeps the list and announces it (only
** what is approved and not hidden); the presenter sees every question in the
** Live poll tab, marks them answered, hides them, or puts one up full screen
** (spotlight). A `.qa` slide shows the board, most upvoted first.
**
** `livepoll: qa: moderated` holds each question back until it is approved;
** `qa: false` turns the whole thing off.
******************************************************************/

(function () {
  if (/print-pdf/gi.test(window.location.search)) return;
  var LP = window.Livepoll;

  var MAX_LENGTH = 280;
  var MAX_PER_PERSON = 5;

  function mode() {
    var qa = LP.config().qa;
    return qa === undefined ? true : qa;
  }

  // Host: every question, whatever its state. status: pending (awaiting
  // approval), open, answered, hidden.
  var questions = [];
  var asked = {}; // who -> how many
  var spotlight = null;
  // What the room was last told; followers draw from it, the host from
  // `questions`.
  var board = [];

  function visible(q) {
    return q.status === "open" || q.status === "answered";
  }

  function publicList() {
    return questions.filter(visible).map(function (q) {
      return { id: q.id, text: q.text, votes: q.votes, status: q.status, t: q.t };
    });
  }

  function find(id) {
    for (var i = 0; i < questions.length; i++) if (questions[i].id === id) return questions[i];
    return null;
  }

  var queued = false;
  function announce() {
    board = publicList();
    draw();
    LP.dirty();
    if (queued) return;
    queued = true;
    setTimeout(function () {
      queued = false;
      LP.broadcast({ sender: "qa", type: "list", items: publicList(), spotlight: spotlight, session: LP.sessionId() });
    }, 250);
  }

  function cleanText(raw) {
    return String(raw || "").replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
  }

  LP.on("qa", function (content, event) {
    if (content.type === "ask" || content.type === "vote") {
      if (!LP.hosting() || mode() === false) return;
      var who = LP.who(event, content);
      if (!who) return;
      if (content.type === "ask") ask(content, event, who);
      else vote(content, who);
    } else if (content.type === "list") {
      if (LP.hosting() || !LP.trusted(event)) return;
      board = Array.isArray(content.items) ? content.items : [];
      setSpotlight(content.spotlight || null);
      draw();
    } else if (content.type === "spotlight") {
      if (LP.hosting() || !LP.trusted(event)) return;
      setSpotlight(content.id || null, content.text);
    }
  });

  function ask(content, event, who) {
    var text = cleanText(content.text);
    if (text.length < 3) return;
    if ((asked[who] || 0) >= MAX_PER_PERSON) return;
    for (var i = 0; i < questions.length; i++) {
      if (questions[i].who === who && questions[i].text === text) return; // sent twice
    }
    asked[who] = (asked[who] || 0) + 1;
    var q = {
      id: "q" + (questions.length + 1),
      text: text,
      votes: 0,
      voters: {},
      status: mode() === "moderated" ? "pending" : "open",
      t: Date.now(),
      who: who,
    };
    questions.push(q);
    // tell the asker which one is theirs, so their page can mark it
    var socket = LP.socketOf(event);
    if (socket) LP.sendTo(socket, { sender: "qa", type: "asked", id: q.id, text: q.text, pending: q.status === "pending", session: LP.sessionId() });
    LP.response({ kind: "qa", id: q.id, who: who, value: text });
    announce();
    drawPanel();
  }

  function vote(content, who) {
    var q = find(content.id);
    if (!q || !visible(q) || q.who === who) return;
    if (content.on && !q.voters[who]) {
      q.voters[who] = true;
      q.votes++;
    } else if (!content.on && q.voters[who]) {
      delete q.voters[who];
      q.votes--;
    } else {
      return;
    }
    announce();
    drawPanel();
  }

  function setStatus(id, status) {
    var q = find(id);
    if (!q) return;
    q.status = status;
    if (status !== "open" && status !== "answered" && spotlight === id) spot(null);
    announce();
    drawPanel();
  }

  function spot(id) {
    spotlight = id;
    var q = id ? find(id) : null;
    setSpotlight(id, q ? q.text : null);
    LP.broadcast({ sender: "qa", type: "spotlight", id: id, text: q ? q.text : null });
    drawPanel();
  }

  document.addEventListener("welcome", function (event) {
    if (!LP.hosting() || mode() === false || !event.content || !event.content.user) return;
    LP.sendTo(event.content.user.id, { sender: "qa", type: "list", items: publicList(), spotlight: spotlight, session: LP.sessionId() });
  });

  LP.persist("qa", {
    save: function () {
      return { questions: questions, asked: asked };
    },
    restore: function (data) {
      questions = data.questions || [];
      asked = data.asked || {};
      board = publicList();
      draw();
      drawPanel();
    },
  });

  // For session.json: who asked, in session.js's own terms.
  LP.questions = function () {
    return questions.map(function (q) {
      return { id: q.id, text: q.text, votes: q.votes, status: q.status, t: q.t, who: q.who };
    });
  };

  document.addEventListener("livepoll-replay", function (event) {
    var recorded = (event.detail || {}).questions;
    if (!Array.isArray(recorded)) return;
    board = recorded.filter(function (q) {
      return q && (q.status === "open" || q.status === "answered");
    });
    draw();
  });

  /* ------------------------------------------------------- the board */

  function ranked(list) {
    // open first, by votes then age; answered after them
    return list.slice().sort(function (a, b) {
      var sa = a.status === "answered" ? 1 : 0;
      var sb = b.status === "answered" ? 1 : 0;
      return sa - sb || b.votes - a.votes || a.t - b.t;
    });
  }

  function draw() {
    var boards = document.querySelectorAll(".lp-qa-q");
    var list = ranked(board);
    for (var i = 0; i < boards.length; i++) {
      var max = Number(boards[i].getAttribute("data-max")) || 6;
      var ol = boards[i].querySelector(".lp-qa-list");
      ol.innerHTML = list
        .slice(0, max)
        .map(function (q) {
          return (
            '<li class="lp-qa-item' + (q.status === "answered" ? " lp-qa-answered" : "") + '">' +
            '<span class="lp-qa-votes">' + q.votes + "</span>" +
            '<span class="lp-qa-text">' + LP.escape(q.text) + "</span></li>"
          );
        })
        .join("");
      var empty = boards[i].querySelector(".lp-empty");
      if (empty) empty.hidden = list.length > 0;
      var count = boards[i].querySelector(".qa-count");
      if (count) count.textContent = list.length;
    }
  }

  /* ------------------------------------------------------- spotlight */

  var overlay = null;

  function setSpotlight(id, text) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "livepoll-spotlight";
      overlay.hidden = true;
      overlay.innerHTML = '<div class="livepoll-spotlight-card"><div class="livepoll-spotlight-label">Question from the audience</div><div class="livepoll-spotlight-text"></div></div>';
      overlay.addEventListener("click", function () {
        if (LP.hosting()) spot(null);
        else overlay.hidden = true;
      });
      document.body.appendChild(overlay);
    }
    if (!id) {
      overlay.hidden = true;
      return;
    }
    if (text === undefined || text === null) {
      for (var i = 0; i < board.length; i++) if (board[i].id === id) text = board[i].text;
    }
    if (!text) return;
    overlay.querySelector(".livepoll-spotlight-text").textContent = text;
    overlay.hidden = false;
  }

  document.addEventListener(
    "keydown",
    function (evt) {
      if (evt.key === "Escape" && overlay && !overlay.hidden) {
        evt.preventDefault();
        evt.stopImmediatePropagation();
        if (LP.hosting()) spot(null);
        else overlay.hidden = true;
      }
    },
    true
  );

  /* ----------------------------------------------- presenter's list */

  var panel = null;

  function drawPanel() {
    if (!panel) return;
    var list = questions.filter(function (q) { return q.status !== "hidden"; });
    var hidden = questions.length - list.length;
    var ordered = list.slice().sort(function (a, b) {
      var rank = { pending: 0, open: 1, answered: 2 };
      return rank[a.status] - rank[b.status] || b.votes - a.votes || a.t - b.t;
    });
    var box = panel.querySelector(".livepoll-qa-list");
    box.innerHTML = ordered.length
      ? ordered
          .map(function (q) {
            var actions =
              (q.status === "pending" ? '<button type="button" data-act="approve" title="Show to everyone">Approve</button>' : "") +
              (q.status === "open" ? '<button type="button" data-act="answered" title="Mark answered">✓</button>' : "") +
              (q.status === "answered" ? '<button type="button" data-act="reopen" title="Mark open again">↺</button>' : "") +
              (q.status !== "pending"
                ? '<button type="button" data-act="spot" title="Show full screen">' + (spotlight === q.id ? "Hide" : "Show") + "</button>"
                : "") +
              '<button type="button" data-act="hide" title="Remove from the board">✕</button>';
            return (
              '<div class="livepoll-qa-item" data-status="' + q.status + '" data-id="' + q.id + '">' +
              '<span class="livepoll-qa-votes">▲' + q.votes + "</span>" +
              '<span class="livepoll-qa-text">' + LP.escape(q.text) + "</span>" +
              '<span class="livepoll-qa-actions">' + actions + "</span></div>"
            );
          })
          .join("")
      : '<p class="livepoll-hint">No questions yet.</p>';
    panel.querySelector(".livepoll-qa-hidden").textContent = hidden ? hidden + " hidden" : "";
    var title = panel.querySelector("h3");
    var waiting = questions.filter(function (q) { return q.status === "pending"; }).length;
    title.textContent = "Questions" + (questions.length ? " (" + list.length + (waiting ? ", " + waiting + " to approve" : "") + ")" : "");
    LP.hud.refresh();
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (mode() === false) return;
    panel = LP.addSection(
      "livepoll-qa",
      "Questions",
      '<div class="livepoll-qa-list"></div><p class="livepoll-hint livepoll-qa-hidden"></p>' +
        '<p class="livepoll-hint">' +
        (mode() === "moderated" ? "Questions wait for your approval before anyone sees them. " : "") +
        "Participants ask and upvote in the Questions tab of the poll page.</p>"
    );
    panel.addEventListener("click", function (evt) {
      var act = evt.target.getAttribute && evt.target.getAttribute("data-act");
      var item = evt.target.closest && evt.target.closest(".livepoll-qa-item");
      if (!act || !item) return;
      if (!LP.hosting()) {
        alert("You must be hosting the seminar for that");
        return;
      }
      var id = item.getAttribute("data-id");
      if (act === "approve" || act === "reopen") setStatus(id, "open");
      else if (act === "answered") setStatus(id, "answered");
      else if (act === "hide") setStatus(id, "hidden");
      else if (act === "spot") spot(spotlight === id ? null : id);
    });
    drawPanel();
    draw();
  });

  LP.hud.add("qa", 40, function () {
    if (!LP.hosting() || mode() === false) return "";
    var open = questions.filter(function (q) { return q.status === "open"; });
    var waiting = questions.filter(function (q) { return q.status === "pending"; }).length;
    if (!open.length && !waiting) return "";
    var top = open.slice().sort(function (a, b) { return b.votes - a.votes || a.t - b.t; }).slice(0, 2);
    return (
      '<div class="lp-hud-title">Questions: ' + open.length + " open" +
      (waiting ? ' <span class="lp-hud-alert">· ' + waiting + " to approve</span>" : "") + "</div>" +
      (top.length
        ? "<ol>" + top.map(function (q) {
            return "<li>▲" + q.votes + " " + LP.escape(q.text.length > 90 ? q.text.slice(0, 88) + "…" : q.text) + "</li>";
          }).join("") + "</ol>"
        : "")
    );
  });
})();
