/*****************************************************************
** livepoll — quiz mode.
**
** With `livepoll: quiz: true` the poll page asks for a nickname (it can be
** skipped), and every question with an answer is scored when the answer is
** revealed: 1000 points for a right answer, scaled down to 500 for a slow
** one when the question has a timer. Each player is told their own result;
** a `.leaderboard` slide shows the top scores.
**
** What counts as right: a poll's marked option(s) (all of them, exactly,
** when it takes several); an estimate within its tolerance="…"; a tap inside
** a hotspot's answer circle; a sketch within its tolerance of the real data. Rating scales, clouds and rankings are opinions
** and score nothing.
******************************************************************/

(function () {
  if (/print-pdf/gi.test(window.location.search)) return;
  var LP = window.Livepoll;

  function enabled() {
    return !!LP.config().quiz;
  }

  // An estimate's tolerance as a plain number either side of the answer, or
  // null when it has none (and so is not scored). questions.js uses it too.
  function tolerance(d) {
    if (!d || typeof d.answer !== "number") return null;
    if (typeof d.tolerance === "number") return d.tolerance;
    if (typeof d.tolerancePct === "number") return (Math.abs(d.answer) * d.tolerancePct) / 100;
    return null;
  }
  window.LivepollQuiz = { tolerance: tolerance };

  /* ------------------------------------------------------------ host */

  var players = {}; // who -> { nick, score, right, answered }
  var sockets = {}; // who -> the socket to reach them on
  var answers = {}; // question id -> [{ who, value, t, round }]
  var roundStarted = {}; // poll id -> when its current round opened
  var scored = {}; // question id -> true once scored
  // question id -> { who: { right, points } }: what each scoring gave, so a
  // reveal taken back (the presenter stepped back) can be taken back too
  var awards = {};
  var anonymous = 0;

  function cleanNick(raw) {
    return String(raw || "")
      .replace(/[\u0000-\u001f\u007f<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20);
  }

  function player(who) {
    if (!players[who]) {
      anonymous++;
      players[who] = { nick: "Player " + anonymous, score: 0, right: 0, answered: 0 };
    }
    return players[who];
  }

  // Remember where each participant can be reached, from anything they send.
  document.addEventListener("received", function (event) {
    if (!enabled() || !LP.hosting() || event.channel !== "message") return;
    var who = LP.who(event, event.content);
    var socket = LP.socketOf(event);
    if (who && socket) sockets[who] = socket;
  });

  LP.on("quiz", function (content, event) {
    if (content.type === "hello") {
      if (!enabled() || !LP.hosting()) return;
      var who = LP.who(event, content);
      if (!who) return;
      var p = player(who);
      var nick = cleanNick(content.nickname);
      if (nick && !p.renamed) {
        // a nickname the word filter flags never reaches the leaderboard: the
        // player gets a neutral one, for good, as the Rename button gives
        if (LP.filter.flags(nick)) p.renamed = true;
        else p.nick = nick;
      }
      LP.sendTo(LP.socketOf(event), { sender: "quiz", type: "you", nickname: p.nick, score: p.score });
      // on the leaderboard from the moment they join, not from the next score
      queueBoard();
      drawPanel();
      LP.dirty();
    } else if (content.type === "board") {
      if (LP.hosting() || !LP.trusted(event)) return;
      drawBoards(content.top || []);
    }
  });

  document.addEventListener("livepoll-response", function (event) {
    if (!enabled()) return;
    var r = event.detail;
    if (r.kind !== "poll" && r.kind !== "estimate" && r.kind !== "hotspot" && r.kind !== "sketch") return;
    var list = answers[r.id] || (answers[r.id] = []);
    list.push({ who: r.who, value: r.value, t: r.t, round: r.round || 1 });
    player(r.who).answered++;
    queueBoard();
  });

  document.addEventListener("livepoll-round", function (event) {
    roundStarted[event.detail.id] = Date.now();
    // a new round is scored afresh when its answer is revealed
    delete scored[event.detail.id];
  });

  function rightAnswer(id, value) {
    var kind = LP.kindOf(id);
    var cfg = LP.config();
    if (kind === "poll") {
      var d = (cfg.polls || {})[id];
      var correct = LP.correctSet(d && d.correct);
      if (!correct.length) return null;
      if (Array.isArray(value)) {
        // several choices: exactly the marked set
        if (value.length !== correct.length) return false;
        return value.every(function (v) { return correct.indexOf(v) !== -1; });
      }
      return correct.indexOf(value) !== -1;
    }
    if (kind === "estimate") {
      var e = (cfg.estimates || {})[id];
      var tol = tolerance(e);
      if (tol === null) return null;
      return Math.abs(value - e.answer) <= tol + 1e-9;
    }
    if (kind === "hotspot") {
      var h = (cfg.hotspots || {})[id];
      if (!h || !Array.isArray(h.answer)) return null;
      var img = document.querySelector('.lp-hotspot[data-hotspot="' + id + '"] img');
      var aspect = img && img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1;
      return LP.hotspotHit(value, h.answer, aspect);
    }
    if (kind === "sketch") {
      // close enough on average to the real data, where the two overlap
      var k = (cfg.sketches || {})[id];
      if (!k || !Array.isArray(k.answer)) return null;
      var off = LP.sketchError(value, k);
      return off !== null && off <= k.tolerance + 1e-9;
    }
    return null;
  }

  // Faster is worth more, but only against a clock: half marks at the bell.
  function points(id, t, round) {
    var timer = (LP.config().timers || {})[id];
    if (!timer) return 1000;
    var opened = (round > 1 && roundStarted[id]) || LP.openedAt(id) || t;
    var share = Math.max(0, Math.min(1, (t - opened) / (timer.seconds * 1000)));
    return Math.round(1000 * (1 - share / 2));
  }

  // Whether a question has a right answer to score against.
  function scorable(id) {
    var cfg = LP.config();
    var kind = LP.kindOf(id);
    if (kind === "poll") return LP.correctSet(((cfg.polls || {})[id] || {}).correct).length > 0;
    if (kind === "estimate") return tolerance((cfg.estimates || {})[id]) !== null;
    if (kind === "hotspot") return Array.isArray(((cfg.hotspots || {})[id] || {}).answer);
    if (kind === "sketch") return Array.isArray(((cfg.sketches || {})[id] || {}).answer);
    return false;
  }

  // Once per question (per round, for a poll with rounds), when its answer is
  // revealed, counting the last round only. A reveal that is taken back
  // (unscore) is scored again, afresh, when the answer is given for real.
  function score(id) {
    if (scored[id] || !scorable(id)) return;
    scored[id] = true;
    var list = answers[id] || [];
    var lastRound = list.reduce(function (m, a) { return Math.max(m, a.round); }, 1);
    var results = {};
    list.forEach(function (a) {
      if (a.round !== lastRound) return;
      var right = rightAnswer(id, a.value) === true;
      var p = player(a.who);
      var gained = right ? points(id, a.t, a.round) : 0;
      p.score += gained;
      if (right) p.right++;
      results[a.who] = { right: right, points: gained };
    });
    awards[id] = results;
    if (!Object.keys(results).length) return;
    var table = standings();
    Object.keys(results).forEach(function (who) {
      if (!sockets[who]) return;
      LP.sendTo(sockets[who], {
        sender: "quiz", type: "result", id: id,
        right: results[who].right, points: results[who].points,
        score: players[who].score, rank: table.rankOf[who], players: table.list.length,
      });
    });
    announceBoard();
    drawPanel();
    LP.dirty();
  }

  // The answer was shown by mistake and taken back: what it scored goes too,
  // and the question is scored again — with everyone who has answered by
  // then — when the answer is revealed for real.
  function unscore(id) {
    var given = awards[id];
    delete scored[id];
    delete awards[id];
    if (!given) return;
    Object.keys(given).forEach(function (who) {
      var p = players[who];
      if (!p) return;
      p.score -= given[who].points;
      if (given[who].right) p.right--;
      if (sockets[who]) LP.sendTo(sockets[who], { sender: "quiz", type: "you", nickname: p.nick, score: p.score });
    });
    announceBoard();
    drawPanel();
    LP.dirty();
  }

  document.addEventListener("livepoll-answer", function (event) {
    if (!enabled() || !LP.hosting()) return;
    if (event.detail.shown) score(event.detail.id);
    else unscore(event.detail.id);
  });

  // Everyone who has joined, scored or not.
  function standings() {
    var list = Object.keys(players)
      .map(function (who) { return { who: who, nick: players[who].nick, score: players[who].score, right: players[who].right }; })
      .sort(function (a, b) { return b.score - a.score || a.nick.localeCompare(b.nick); });
    var rankOf = {};
    list.forEach(function (p, i) {
      // equal scores share a place
      rankOf[p.who] = i > 0 && list[i - 1].score === p.score ? rankOf[list[i - 1].who] : i + 1;
    });
    return { list: list, rankOf: rankOf };
  }

  function top() {
    return standings().list.slice(0, 20).map(function (p) {
      return { nick: p.nick, score: p.score };
    });
  }

  function announceBoard() {
    var board = top();
    drawBoards(board);
    LP.broadcast({ sender: "quiz", type: "board", top: board });
  }

  // A burst of joins or answers is one redraw.
  var boardQueued = false;
  function queueBoard() {
    if (boardQueued || !LP.hosting()) return;
    boardQueued = true;
    setTimeout(function () {
      boardQueued = false;
      announceBoard();
    }, 400);
  }

  document.addEventListener("welcome", function (event) {
    if (!enabled() || !LP.hosting() || !event.content || !event.content.user) return;
    LP.sendTo(event.content.user.id, { sender: "quiz", type: "board", top: top() });
  });

  LP.persist("quiz", {
    save: function () {
      return { players: players, answers: answers, scored: scored, awards: awards, anonymous: anonymous, roundStarted: roundStarted };
    },
    restore: function (data) {
      players = data.players || {};
      answers = data.answers || {};
      scored = data.scored || {};
      awards = data.awards || {};
      anonymous = data.anonymous || 0;
      roundStarted = data.roundStarted || {};
      drawBoards(top());
      drawPanel();
    },
  });

  // For session.json.
  LP.leaderboard = function () {
    return enabled() ? standings().list : [];
  };

  document.addEventListener("livepoll-replay", function (event) {
    var recorded = (event.detail || {}).leaderboard;
    if (Array.isArray(recorded)) drawBoards(recorded);
  });

  /* ---------------------------------------------------------- slides */

  function drawBoards(board) {
    var boxes = document.querySelectorAll(".lp-leader-q");
    var max = Math.max.apply(null, board.map(function (p) { return p.score; }).concat([1]));
    // equal scores share a place
    var places = [];
    board.forEach(function (p, k) {
      places.push(k > 0 && board[k - 1].score === p.score ? places[k - 1] : k + 1);
    });
    for (var i = 0; i < boxes.length; i++) {
      var n = Number(boxes[i].getAttribute("data-leaderboard")) || 10;
      boxes[i].querySelector(".lp-leaderboard").innerHTML = board
        .slice(0, n)
        .map(function (p, k) {
          return (
            '<li class="lp-leader-row"><span class="lp-leader-place">' + places[k] + "</span>" +
            '<span class="lp-leader-name">' + LP.escape(p.nick) + "</span>" +
            '<span class="lp-track"><span class="lp-fill" style="width:' + ((p.score / max) * 100).toFixed(1) + '%"></span></span>' +
            '<span class="lp-leader-score">' + p.score + "</span></li>"
          );
        })
        .join("");
      var empty = boxes[i].querySelector(".lp-empty");
      if (empty) empty.hidden = board.length > 0;
    }
  }

  /* ------------------------------------------------ presenter's list */

  var panel = null;

  function drawPanel() {
    if (!panel) return;
    var table = standings().list;
    var all = Object.keys(players).length;
    panel.querySelector("h3").textContent = "Quiz (" + all + (all === 1 ? " player)" : " players)");
    panel.querySelector(".livepoll-quiz-list").innerHTML = table.length
      ? table.slice(0, 15).map(function (p, i) {
          return (
            '<div class="livepoll-quiz-item" data-who="' + LP.escape(p.who) + '">' +
            '<span class="livepoll-quiz-rank">' + (i + 1) + ".</span> " +
            '<span class="livepoll-quiz-nick">' + LP.escape(p.nick) + "</span> " +
            '<span class="livepoll-quiz-score">' + p.score + "</span>" +
            '<button type="button" data-act="anon" title="Replace this nickname with a neutral one">Rename</button></div>'
          );
        }).join("")
      : '<p class="livepoll-hint">No scores yet: questions are scored as their answer is revealed.</p>';
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!enabled()) return;
    panel = LP.addSection("livepoll-quiz", "Quiz", '<div class="livepoll-quiz-list"></div>');
    panel.addEventListener("click", function (evt) {
      if (!evt.target.getAttribute || evt.target.getAttribute("data-act") !== "anon") return;
      var item = evt.target.closest(".livepoll-quiz-item");
      var who = item && item.getAttribute("data-who");
      if (!who || !players[who]) return;
      anonymous++;
      players[who].nick = "Player " + anonymous;
      players[who].renamed = true; // and it stays renamed
      if (sockets[who]) LP.sendTo(sockets[who], { sender: "quiz", type: "you", nickname: players[who].nick, score: players[who].score });
      announceBoard();
      drawPanel();
      LP.dirty();
    });
    drawPanel();
  });
})();
