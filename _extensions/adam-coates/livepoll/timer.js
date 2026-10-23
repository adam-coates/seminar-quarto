/*****************************************************************
** livepoll — timers.
**
** timer="60" on a question (livepoll.lua publishes it as `timers`) starts a
** countdown when the question is opened. When it runs out, voting closes
** (LP.close) and, unless on-timeout="close", the deck steps to the slide's
** next livepoll step: the answer, the hidden results, or the next round.
**
** The host keeps the clock and announces it on every change (start, pause,
** +15 s, stop) as the time remaining, not as a moment: the phones' clocks need
** not agree with the presenter's. Everyone counts down from that locally.
******************************************************************/

(function () {
  if (/print-pdf/gi.test(window.location.search)) return;
  var LP = window.Livepoll;

  // id -> { duration, endsAt, remaining, running, done } in ms; endsAt is
  // this browser's clock, remaining is what is left while paused
  var clocks = {};

  function settings(id) {
    return (LP.config().timers || {})[id] || null;
  }

  function left(clock) {
    if (!clock) return 0;
    if (clock.running) return Math.max(0, clock.endsAt - Date.now());
    return clock.remaining;
  }

  function format(ms) {
    var s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /* ------------------------------------------------------------- host */

  function announce(id) {
    var clock = clocks[id];
    if (!clock) return;
    LP.broadcast({
      sender: "timer", type: "timer", pollId: id,
      remaining: left(clock), duration: clock.duration, running: clock.running, done: clock.done,
    });
    LP.dirty();
    draw();
  }

  function start(id, seconds) {
    var ms = seconds * 1000;
    clocks[id] = { duration: ms, endsAt: Date.now() + ms, remaining: ms, running: true, done: false };
    announce(id);
  }

  function pause(id) {
    var clock = clocks[id];
    if (!clock || !clock.running) return;
    clock.remaining = left(clock);
    clock.running = false;
    announce(id);
  }

  function resume(id) {
    var clock = clocks[id];
    if (!clock || clock.running || clock.done) return;
    clock.endsAt = Date.now() + clock.remaining;
    clock.running = true;
    announce(id);
  }

  function extend(id, ms) {
    var clock = clocks[id];
    if (!clock) return;
    if (clock.done) {
      // more time after it ran out: open voting again
      clock.done = false;
      clock.remaining = 0;
      LP.reopen(id);
    }
    clock.duration += ms;
    if (clock.running) clock.endsAt += ms;
    else {
      clock.remaining += ms;
      clock.endsAt = Date.now() + clock.remaining;
      clock.running = true;
    }
    announce(id);
  }

  function expire(id, quiet) {
    var clock = clocks[id];
    if (!clock || clock.done) return;
    clock.running = false;
    clock.remaining = 0;
    clock.done = true;
    announce(id);
    LP.close(id);
    LP.log("Time's up: " + id);
    var s = settings(id);
    if (!quiet && (!s || s.onTimeout !== "close")) advance(id);
  }

  // Step to the answer — but only if this question is on the slide being
  // shown and the very next fragment there is one of livepoll's steps. A
  // presenter who has moved on, or has their own fragments next, is left be.
  function advance(id) {
    if (!window.Reveal || !Reveal.getCurrentSlide) return;
    var slide = Reveal.getCurrentSlide();
    if (!slide) return;
    var here = false;
    slide.querySelectorAll(".livepoll-question, .poll[data-poll], .wordcloud, .likert").forEach(function (el) {
      if (LP.questionId(el) === id) here = true;
    });
    if (!here) return;
    var next = null;
    var pending = slide.querySelectorAll(".fragment:not(.visible)");
    for (var i = 0; i < pending.length; i++) {
      var idx = Number(pending[i].getAttribute("data-fragment-index"));
      if (!next || idx < Number(next.getAttribute("data-fragment-index"))) next = pending[i];
    }
    if (next && next.classList.contains("lp-step") && next.getAttribute("data-poll") === id) {
      Reveal.nextFragment();
    } else if (next && next.classList.contains("lp-round-note") && next.getAttribute("data-poll") === id) {
      Reveal.nextFragment();
    }
  }

  // Opening a timed question starts its clock, once: stepping back to a
  // question whose time ran out does not open it again (Re-open does).
  document.addEventListener("livepoll-activated", function (event) {
    var id = event.detail.id;
    if (!id || !LP.hosting()) return;
    var s = settings(id);
    if (!s || clocks[id] || !LP.isOpen(id)) return;
    start(id, s.seconds);
  });

  // A new round is a new vote, with the full time again.
  document.addEventListener("livepoll-round", function (event) {
    var s = settings(event.detail.id);
    if (s && LP.hosting()) start(event.detail.id, s.seconds);
  });

  // Closing by hand stops the clock where it is; re-opening a question whose
  // time had run out gives it its time again.
  document.addEventListener("livepoll-closed", function (event) {
    if (!LP.hosting()) return;
    var id = event.detail.id;
    var clock = clocks[id];
    if (event.detail.closed && clock && clock.running) {
      clock.remaining = left(clock);
      clock.running = false;
      clock.done = true;
      announce(id);
    } else if (!event.detail.closed && clock && clock.done && left(clock) === 0) {
      var s = settings(id);
      if (s) start(id, s.seconds);
    }
  });

  setInterval(function () {
    if (LP.hosting()) {
      Object.keys(clocks).forEach(function (id) {
        var clock = clocks[id];
        if (clock.running && left(clock) <= 0) expire(id);
      });
    }
    draw();
  }, 250);

  document.addEventListener("welcome", function (event) {
    if (!LP.hosting() || !event.content || !event.content.user) return;
    var id = LP.active();
    var clock = clocks[id];
    if (!clock) return;
    LP.sendTo(event.content.user.id, {
      sender: "timer", type: "timer", pollId: id,
      remaining: left(clock), duration: clock.duration, running: clock.running, done: clock.done,
    });
  });

  LP.persist("timers", {
    save: function () {
      var out = {};
      Object.keys(clocks).forEach(function (id) {
        var c = clocks[id];
        out[id] = { duration: c.duration, remaining: left(c), done: c.done };
      });
      return out;
    },
    // paused where they were: the class is not sitting there while the
    // presenter restores
    restore: function (data) {
      Object.keys(data || {}).forEach(function (id) {
        var c = data[id];
        clocks[id] = { duration: c.duration, remaining: c.remaining, endsAt: 0, running: false, done: !!c.done };
      });
      draw();
    },
  });

  /* ----------------------------------------------------- followers */

  LP.on("timer", function (content, event) {
    if (LP.hosting() || !LP.trusted(event) || content.type !== "timer") return;
    clocks[content.pollId] = {
      duration: content.duration,
      remaining: content.remaining,
      endsAt: Date.now() + content.remaining,
      running: !!content.running,
      done: !!content.done,
    };
    draw();
  });

  /* --------------------------------------------------------- drawing */

  function draw() {
    var els = document.querySelectorAll(".lp-timer[data-timer]");
    for (var i = 0; i < els.length; i++) {
      var id = els[i].getAttribute("data-timer");
      var clock = clocks[id];
      if (!clock) {
        els[i].hidden = true;
        continue;
      }
      var ms = left(clock);
      els[i].hidden = false;
      var ring = els[i].querySelector(".lp-timer-ring");
      var used = clock.duration > 0 ? 1 - ms / clock.duration : 1;
      if (ring) ring.style.strokeDashoffset = String((used * 100).toFixed(2));
      var text = els[i].querySelector(".lp-timer-text");
      var label = clock.done ? "0:00" : format(ms);
      if (text && text.textContent !== label) text.textContent = label;
      els[i].classList.toggle("lp-timer-low", !clock.done && ms <= 10000);
      els[i].classList.toggle("lp-timer-paused", !clock.running && !clock.done);
      els[i].classList.toggle("lp-timer-done", clock.done);
    }
  }

  LP.hud.add("timer", 20, function () {
    if (!LP.hosting()) return "";
    var id = LP.active();
    var clock = clocks[id];
    if (!clock) return "";
    var ms = left(clock);
    var state = clock.done ? "time's up" : clock.running ? "left" : "left (paused)";
    return (
      '<span class="lp-hud-big' + (!clock.done && ms <= 10000 ? " lp-hud-alert" : "") + '">' +
      (clock.done ? "0:00" : format(ms)) + "</span> " + state
    );
  });

  /* --------------------------------------------------------- controls */

  function target() {
    var selector = document.getElementById("pollSelector");
    var id = (selector && selector.value) || LP.active();
    if (!id) {
      alert("Select a question first");
      return null;
    }
    if (!LP.hosting()) {
      alert("You must be hosting the seminar for that");
      return null;
    }
    return id;
  }

  // Shift+T, and the panel's Pause button: pause or resume the active
  // question's timer, or start one (60 s, or its own length) if it has none.
  function toggle(id) {
    var clock = clocks[id];
    if (!clock || clock.done) {
      var s = settings(id);
      if (!LP.isOpen(id)) LP.reopen(id);
      start(id, s ? s.seconds : 60);
    } else if (clock.running) pause(id);
    else resume(id);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var section = LP.addSection(
      "livepoll-timer-section",
      "Timer",
      '<button type="button" data-act="toggle" title="Shift+T">Start / pause</button>' +
        '<button type="button" data-act="plus">+15 s</button>' +
        '<button type="button" data-act="end">End now</button>' +
        '<p class="livepoll-hint">Questions with timer="…" start counting when opened. Start gives any other question 60 s.</p>'
    );
    section.addEventListener("click", function (evt) {
      var act = evt.target.getAttribute && evt.target.getAttribute("data-act");
      if (!act) return;
      var id = target();
      if (!id) return;
      if (act === "toggle") toggle(id);
      else if (act === "plus") {
        if (clocks[id]) extend(id, 15000);
        else start(id, 15);
      } else if (act === "end") {
        if (clocks[id]) expire(id, true);
        else LP.close(id);
      }
    });
  });

  document.addEventListener(
    "keydown",
    function (evt) {
      var tag = (evt.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (evt.key === "T" && evt.shiftKey && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
        if (!LP.hosting() || !LP.active()) return;
        evt.preventDefault();
        evt.stopImmediatePropagation();
        toggle(LP.active());
      }
    },
    true
  );
})();
