/*****************************************************************
** livepoll — signals and reactions.
**
** Two things the audience can send at any moment, from a bar at the foot of
** the poll page:
**
**   signals    "You've lost me" and "Slow down". Each lasts signal-window
**              seconds (120 by default) unless taken back, and is shown only
**              to the presenter — in the Live poll tab and the speaker view —
**              as how many people are signalling right now.
**   reactions  👍 👏 😂 😮 ❤️ 🤔, which float up the projected slide.
**
** Both are off unless the deck asks: `livepoll: signals: true` and/or
** `reactions: true`.
******************************************************************/

(function () {
  if (/print-pdf/gi.test(window.location.search)) return;
  var LP = window.Livepoll;

  // By position: a reaction travels as its index, never as text.
  var EMOJI = ["👍", "👏", "😂", "😮", "❤️", "🤔"];
  var KINDS = { lost: "lost", slow: "slow" };

  function on(key) {
    return LP.config()[key] === true;
  }

  function windowMs() {
    return (Number(LP.config().signalWindow) || 120) * 1000;
  }

  function currentSlideId() {
    var slide = window.Reveal && Reveal.getCurrentSlide && Reveal.getCurrentSlide();
    return slide ? slide.id || null : null;
  }

  /* ------------------------------------------------------- signals */

  // who -> { lost: until, slow: until } (host only)
  var active = {};

  function count(kind) {
    var now = Date.now();
    var n = 0;
    for (var who in active) if (active[who][kind] && active[who][kind] > now) n++;
    return n;
  }

  function logSignal(kind, state) {
    document.dispatchEvent(new CustomEvent("livepoll-signal", { detail: { t: Date.now(), kind: kind, on: state, slide: currentSlideId() } }));
  }

  function clearAll() {
    active = {};
    LP.broadcast({ sender: "signal", type: "cleared" });
    logSignal("cleared", false);
    draw();
  }

  /* ----------------------------------------------------- reactions */

  var lastReaction = {}; // who -> time, host only
  var recent = []; // times of reactions shown in the last second

  var layer = null;
  function float(index) {
    var emoji = EMOJI[index];
    if (!emoji) return;
    var now = Date.now();
    recent = recent.filter(function (t) { return now - t < 1000; });
    if (recent.length >= 12) return; // a storm: show some, not all
    recent.push(now);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "livepoll-reactions";
      layer.setAttribute("aria-hidden", "true");
      document.body.appendChild(layer);
    }
    var el = document.createElement("span");
    el.className = "livepoll-reaction";
    el.textContent = emoji;
    el.style.right = (3 + Math.random() * 12).toFixed(1) + "vw";
    el.style.setProperty("--lp-drift", (Math.random() * 6 - 3).toFixed(1) + "vw");
    layer.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3200);
  }

  LP.on("signal", function (content, event) {
    if (content.type === "signal") {
      if (!LP.hosting() || !on("signals") || !KINDS[content.kind]) return;
      var who = LP.who(event, content);
      if (!who) return;
      var mine = active[who] || (active[who] = {});
      var was = mine[content.kind] && mine[content.kind] > Date.now();
      mine[content.kind] = content.on ? Date.now() + windowMs() : 0;
      if (!!content.on !== !!was) logSignal(content.kind, !!content.on);
      draw();
    } else if (content.type === "react") {
      if (!LP.hosting() || !on("reactions")) return;
      var index = Number(content.emoji);
      if (!(index >= 0 && index < EMOJI.length)) return;
      var sender = LP.who(event, content) || "?";
      if (lastReaction[sender] && Date.now() - lastReaction[sender] < 800) return;
      lastReaction[sender] = Date.now();
      float(index);
      LP.broadcast({ sender: "signal", type: "reaction", emoji: index });
      document.dispatchEvent(new CustomEvent("livepoll-reaction", { detail: { t: Date.now(), emoji: EMOJI[index], slide: currentSlideId() } }));
    } else if (content.type === "reaction") {
      if (LP.hosting() || !LP.trusted(event)) return;
      float(Number(content.emoji));
    }
  });

  /* ------------------------------------------------- for the presenter */

  // An alert, not just a number, once it is more than a couple of people or
  // a tenth of the room.
  function alerting(n) {
    return n >= Math.max(2, Math.ceil(LP.connectedCount() * 0.1));
  }

  var panel = null;

  function draw() {
    LP.hud.refresh();
    if (!panel) return;
    var lost = count("lost");
    var slow = count("slow");
    var box = panel.querySelector(".livepoll-signals-now");
    box.innerHTML =
      '<span class="' + (alerting(lost) ? "livepoll-alert" : "") + '">😕 ' + lost + " lost</span> · " +
      '<span class="' + (alerting(slow) ? "livepoll-alert" : "") + '">🐢 ' + slow + " slow down</span>";
  }

  // Signals run out by themselves; keep the numbers honest.
  setInterval(function () {
    if (LP.hosting()) draw();
  }, 5000);

  LP.hud.add("signals", 30, function () {
    if (!LP.hosting() || !on("signals")) return "";
    var lost = count("lost");
    var slow = count("slow");
    if (!lost && !slow) return '<span class="lp-hud-muted">😕 0 lost · 🐢 0 slow</span>';
    return (
      '<span class="' + (alerting(lost) ? "lp-hud-alert" : "") + '">😕 ' + lost + " lost</span> · " +
      '<span class="' + (alerting(slow) ? "lp-hud-alert" : "") + '">🐢 ' + slow + " slow</span>"
    );
  });

  document.addEventListener("DOMContentLoaded", function () {
    if (!on("signals")) return;
    panel = LP.addSection(
      "livepoll-signals",
      "Audience signals",
      '<p class="livepoll-signals-now"></p>' +
        '<button type="button" data-act="clear">Clear signals</button>' +
        '<p class="livepoll-hint">How many people pressed "You\'ve lost me" or "Slow down" in the last ' +
        Math.round(windowMs() / 1000) + " s. Only you see this (here and in the speaker view, S).</p>"
    );
    panel.addEventListener("click", function (evt) {
      if (evt.target.getAttribute && evt.target.getAttribute("data-act") === "clear") {
        if (!LP.hosting()) return;
        clearAll();
      }
    });
    draw();
  });
})();
