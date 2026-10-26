/*****************************************************************
** livepoll — estimates, rankings and hotspots.
**
** Three kinds of question beside polls, clouds and rating scales, each kept
** the way those are: the phones send answers to the host, the host keeps the
** tally and announces it, and every deck draws from the announcement.
**
**   .estimate  a number: a histogram of the guesses, the median, and the
**              answer as a line once it is revealed
**   .rank      put items in order: sorted by points (first place gets the
**              most), the bars sliding as the order changes
**   .hotspot   tap a point on an image: a heat map of the taps, and the
**              answer as a circle
**   .sketch    draw your guess: every curve faintly, the class's median
**              and middle half, and the real data once it is revealed
******************************************************************/

(function () {
  if (/print-pdf/gi.test(window.location.search)) return;
  var LP = window.Livepoll;

  var raf =
    window.requestAnimationFrame ||
    function (cb) {
      return setTimeout(cb, 16);
    };

  // each kind's table in the deck's config, and in session.json
  var TABLES = { estimate: "estimates", rank: "ranks", hotspot: "hotspots", sketch: "sketches" };

  function def(kind, id) {
    return (LP.config()[TABLES[kind]] || {})[id] || null;
  }

  function els(kind, id) {
    return document.querySelectorAll(".lp-" + kind + '[data-' + kind + '="' + id + '"]');
  }

  function setCount(kind, id, n) {
    var counters = document.querySelectorAll("." + kind + '-voters[data-' + kind + '="' + id + '"]');
    for (var i = 0; i < counters.length; i++) counters[i].textContent = n;
  }

  // A kind: how to check an answer, add it, describe the tally for the room,
  // take a tally from the room, and draw it. The plumbing around that —
  // voting once, closed questions, throttled announcements, late joiners,
  // autosave, reset, replay — is the same for all three.
  function register(kind, spec) {
    var tallies = {}; // id -> spec.empty(def), host and followers alike
    var seen = {}; // id -> LP.claim record, host only
    var queued = {};
    var replayed = {}; // id -> true while it shows a recording

    function tally(id) {
      if (!tallies[id]) tallies[id] = spec.empty(def(kind, id));
      return tallies[id];
    }

    function repaint(id) {
      var boxes = els(kind, id);
      for (var i = 0; i < boxes.length; i++) spec.draw(boxes[i], tally(id), def(kind, id), id);
      setCount(kind, id, spec.count(tally(id)));
    }

    // A burst of answers is one announcement every 300 ms, not one each.
    function announce(id) {
      if (queued[id]) return;
      queued[id] = true;
      setTimeout(function () {
        queued[id] = false;
        LP.broadcast(Object.assign({ sender: kind, type: "tally", id: id }, spec.wire(tally(id))));
      }, 300);
    }

    LP.on(kind, function (content, event) {
      var d = def(kind, content.id);
      if (!d) return;
      if (content.type === "answer") {
        if (!LP.hosting() || !LP.isOpen(content.id)) return;
        var value = spec.check(content, d);
        if (value === null) return;
        var record = seen[content.id] || (seen[content.id] = {});
        if (!LP.claim(record, event, content)) {
          LP.refuse(event, content.id);
          return;
        }
        // Results replayed from session.json are what last class said; a live
        // answer starts afresh, as a poll's first vote does.
        if (replayed[content.id]) {
          delete replayed[content.id];
          tallies[content.id] = spec.empty(d);
        }
        spec.add(tally(content.id), value, d);
        repaint(content.id);
        announce(content.id);
        LP.response({ kind: kind, id: content.id, who: LP.who(event, content), value: value });
      } else if (content.type === "tally") {
        if (!LP.trusted(event) || LP.hosting()) return;
        tallies[content.id] = spec.unwire(content, d);
        repaint(content.id);
      }
    });

    document.addEventListener("welcome", function (event) {
      var id = LP.active();
      if (!LP.hosting() || !tallies[id] || !event.content || !event.content.user) return;
      LP.sendTo(event.content.user.id, Object.assign({ sender: kind, type: "tally", id: id }, spec.wire(tallies[id])));
    });

    // Charts measure their box, which only has a size on screen.
    document.addEventListener("livepoll-slide", function (event) {
      var boxes = event.detail.slide.querySelectorAll(".lp-" + kind + "[data-" + kind + "]");
      for (var i = 0; i < boxes.length; i++) repaint(boxes[i].getAttribute("data-" + kind));
    });

    document.addEventListener("livepoll-answer", function (event) {
      if (def(kind, event.detail.id)) repaint(event.detail.id);
    });

    // session.json, replayed by livepoll.lua: the raw answers, re-tallied
    document.addEventListener("livepoll-replay", function (event) {
      var recorded = (event.detail || {})[TABLES[kind]] || {};
      Object.keys(recorded).forEach(function (id) {
        var d = def(kind, id);
        if (!d) return;
        var t = spec.empty(d);
        (recorded[id] || []).forEach(function (value) {
          var checked = spec.check(spec.asAnswer(value), d);
          if (checked !== null) spec.add(t, checked, d);
        });
        tallies[id] = t;
        replayed[id] = true;
        repaint(id);
      });
    });

    LP.persist(kind, {
      save: function () {
        return { tallies: tallies, seen: seen };
      },
      restore: function (data) {
        seen = data.seen || {};
        tallies = data.tallies || {};
        replayed = {};
        Object.keys(tallies).forEach(repaint);
      },
    });

    LP.kinds[kind] = {
      reset: function (id) {
        tallies[id] = spec.empty(def(kind, id));
        seen[id] = {};
        repaint(id);
        announce(id);
      },
      count: function (id) {
        return { n: spec.count(tally(id)), label: spec.unit };
      },
      // what session.js writes: the raw answers
      answers: function (id) {
        return tallies[id] ? spec.raw(tallies[id]) : [];
      },
      ids: function () {
        return Object.keys(tallies);
      },
    };

    // first paint: empty states, axes
    document.addEventListener("DOMContentLoaded", function () {
      var boxes = document.querySelectorAll(".lp-" + kind + "[data-" + kind + "]");
      for (var i = 0; i < boxes.length; i++) repaint(boxes[i].getAttribute("data-" + kind));
    });
  }

  function numberText(x) {
    if (!isFinite(x)) return "";
    var abs = Math.abs(x);
    if (abs >= 1000 || x === Math.round(x)) return String(Math.round(x));
    if (abs >= 10) return x.toFixed(1).replace(/\.0$/, "");
    return String(Math.round(x * 100) / 100);
  }

  /* -------------------------------------------------------- estimate */

  function median(sorted) {
    if (!sorted.length) return null;
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Round numbers for the axis: about five ticks across [lo, hi].
  function niceStep(span) {
    var raw = span / 5;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  // The range the histogram covers: the question's min and max if it has
  // them, else the answers' own (and the answer's, once it is shown).
  function estimateRange(values, d, withAnswer) {
    var lo = d.min, hi = d.max;
    if (lo === undefined || lo === null || hi === undefined || hi === null) {
      var all = values.slice();
      if (withAnswer && typeof d.answer === "number") all.push(d.answer);
      if (!all.length) return null;
      var a = Math.min.apply(null, all);
      var b = Math.max.apply(null, all);
      if (a === b) {
        a -= 1;
        b += 1;
      }
      var pad = (b - a) * 0.05;
      lo = lo !== undefined && lo !== null ? lo : a - pad;
      hi = hi !== undefined && hi !== null ? hi : b + pad;
    }
    return { lo: lo, hi: hi };
  }

  function binsFor(values, range, d) {
    var span = range.hi - range.lo;
    var whole = values.every(function (v) { return v === Math.round(v); });
    // whole numbers over a short range: a bar per number
    if (!d.bins && whole && span <= 30 && d.min !== undefined && d.min !== null) {
      return { n: Math.round(span) + 1, lo: range.lo - 0.5, width: 1 };
    }
    // a fixed range: twenty bins, so the bars do not reshape as answers come
    // in; an open one: more bins as there are more answers
    var fixed = d.min !== undefined && d.min !== null && d.max !== undefined && d.max !== null;
    var n = d.bins || (fixed ? 20 : Math.max(6, Math.min(24, Math.round(Math.sqrt(values.length) * 2.5))));
    return { n: n, lo: range.lo, width: span / n };
  }

  register("estimate", {
    unit: "answers",
    empty: function () {
      return { values: [] };
    },
    asAnswer: function (value) {
      return { value: value };
    },
    check: function (content, d) {
      var v = Number(content.value);
      if (typeof content.value === "boolean" || content.value === "" || !isFinite(v)) return null;
      if (d.min !== undefined && d.min !== null && v < d.min) return null;
      if (d.max !== undefined && d.max !== null && v > d.max) return null;
      return v;
    },
    add: function (t, v) {
      t.values.push(v);
    },
    count: function (t) {
      return t.values.length;
    },
    wire: function (t) {
      return { values: t.values };
    },
    unwire: function (content) {
      return { values: (content.values || []).filter(function (v) { return typeof v === "number" && isFinite(v); }) };
    },
    raw: function (t) {
      return t.values.slice();
    },
    draw: function (box, t, d, id) {
      var values = t.values;
      var shown = LP.answerShown(id) && typeof d.answer === "number";
      var empty = box.querySelector(".lp-empty");
      if (empty) empty.hidden = values.length > 0;
      var range = estimateRange(values, d, shown);
      var barsBox = box.querySelector(".lp-est-bars");
      var axis = box.querySelector(".lp-est-axis");
      var summary = box.querySelector(".lp-est-summary");
      if (!range) {
        barsBox.innerHTML = "";
        axis.innerHTML = "";
        summary.textContent = "";
        return;
      }
      var bins = binsFor(values, range, d);
      var counts = [];
      for (var i = 0; i < bins.n; i++) counts.push(0);
      values.forEach(function (v) {
        var k = Math.floor((v - bins.lo) / bins.width);
        counts[Math.max(0, Math.min(bins.n - 1, k))]++;
      });
      var max = Math.max.apply(null, counts.concat([1]));

      // bars are reused, so a new answer grows one rather than redrawing all
      var bars = barsBox.children;
      while (bars.length > bins.n) barsBox.removeChild(barsBox.lastChild);
      while (bars.length < bins.n) {
        var bar = document.createElement("div");
        bar.className = "lp-est-bar";
        bar.innerHTML = "<span></span>";
        barsBox.appendChild(bar);
      }
      for (var b = 0; b < bins.n; b++) {
        bars[b].style.height = ((counts[b] / max) * 100).toFixed(2) + "%";
        bars[b].firstChild.textContent = counts[b] ? counts[b] : "";
        bars[b].title = numberText(bins.lo + b * bins.width) + " – " + numberText(bins.lo + (b + 1) * bins.width);
      }

      // where a value sits along the axis, in %
      var lo = bins.lo;
      var hi = bins.lo + bins.n * bins.width;
      var at = function (v) {
        return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
      };

      var step = niceStep(hi - lo);
      var ticks = [];
      for (var x = Math.ceil(lo / step) * step; x <= hi + 1e-9; x += step) ticks.push(x);
      axis.innerHTML = ticks
        .map(function (x) {
          return '<span style="left:' + at(x).toFixed(2) + '%">' + numberText(x) + "</span>";
        })
        .join("");

      var sorted = values.slice().sort(function (a, b) { return a - b; });
      var med = median(sorted);
      // "42%", but "42 kg"
      var unit = d.unit ? (/^[%°‰]/.test(d.unit) ? d.unit : " " + d.unit) : "";
      var medLine = box.querySelector(".lp-est-median");
      medLine.hidden = med === null;
      if (med !== null) {
        medLine.style.left = at(med).toFixed(2) + "%";
        medLine.firstChild.textContent = "median " + numberText(med) + unit;
      }
      var ansLine = box.querySelector(".lp-est-answer");
      ansLine.hidden = !shown;
      if (shown) {
        ansLine.style.left = at(d.answer).toFixed(2) + "%";
        ansLine.firstChild.textContent = "answer " + numberText(d.answer) + unit;
      }
      if (!values.length) {
        summary.textContent = "";
        return;
      }
      var mean = values.reduce(function (a, b) { return a + b; }, 0) / values.length;
      var text = values.length + (values.length === 1 ? " answer" : " answers") +
        " · median " + numberText(med) + unit + " · mean " + numberText(mean) + unit;
      if (shown) {
        var tol = window.LivepollQuiz ? window.LivepollQuiz.tolerance(d) : null;
        if (tol !== null) {
          var close = values.filter(function (v) { return Math.abs(v - d.answer) <= tol; }).length;
          text += " · " + close + " within ±" + numberText(tol);
        }
      }
      summary.textContent = text;
    },
  });

  /* ------------------------------------------------------------ rank */

  register("rank", {
    unit: "responses",
    empty: function (d) {
      var n = d ? d.items.length : 0;
      var zeros = function () {
        var a = [];
        for (var i = 0; i < n; i++) a.push(0);
        return a;
      };
      // points: first place earns `top`, then top-1 ... ; firsts: times first;
      // places: the sum of the places given, for the average
      return { points: zeros(), firsts: zeros(), places: zeros(), placed: zeros(), voters: 0, rankings: [] };
    },
    asAnswer: function (value) {
      return { order: value };
    },
    check: function (content, d) {
      var order = content.order;
      var top = d.top || d.items.length;
      if (!Array.isArray(order) || order.length < 1 || order.length > top) return null;
      var seen = {};
      for (var i = 0; i < order.length; i++) {
        var k = order[i];
        if (typeof k !== "number" || k !== Math.floor(k) || k < 0 || k >= d.items.length || seen[k]) return null;
        seen[k] = true;
      }
      return order.slice();
    },
    add: function (t, order, d) {
      var top = d.top || d.items.length;
      order.forEach(function (item, place) {
        t.points[item] += top - place;
        t.places[item] += place + 1;
        t.placed[item]++;
        if (place === 0) t.firsts[item]++;
      });
      t.voters++;
      t.rankings.push(order);
    },
    count: function (t) {
      return t.voters;
    },
    wire: function (t) {
      return { points: t.points, firsts: t.firsts, places: t.places, placed: t.placed, voters: t.voters };
    },
    unwire: function (content, d) {
      var t = this.empty(d);
      ["points", "firsts", "places", "placed"].forEach(function (k) {
        if (Array.isArray(content[k]) && content[k].length === d.items.length) t[k] = content[k];
      });
      t.voters = content.voters || 0;
      return t;
    },
    raw: function (t) {
      return t.rankings.slice();
    },
    draw: function (box, t, d) {
      var rows = box.querySelectorAll(".lp-rank-row");
      var n = rows.length;
      var order = [];
      for (var i = 0; i < n; i++) order.push(i);
      // most points first; ties keep the deck's order
      order.sort(function (a, b) {
        return t.points[b] - t.points[a] || a - b;
      });
      var max = Math.max.apply(null, t.points.concat([1]));
      order.forEach(function (item, place) {
        var row = rows[item];
        row.style.setProperty("--lp-place", place);
        row.querySelector(".lp-rank-pos").textContent = t.voters ? place + 1 : "";
        row.querySelector(".lp-fill").style.width = ((t.points[item] / max) * 100).toFixed(2) + "%";
        var stat = "";
        if (t.placed[item]) {
          stat = "avg " + numberText(t.places[item] / t.placed[item]);
          if (t.firsts[item]) stat += " · " + t.firsts[item] + "× first";
        }
        row.querySelector(".lp-rank-stat").textContent = stat;
        row.classList.toggle("lp-lead", t.voters > 0 && place === 0);
      });
    },
  });

  /* --------------------------------------------------------- hotspot */

  // The heat map: every tap a soft disc, summed, then coloured from cool to
  // hot. Drawn at the image's size on screen; redrawn when that changes.
  function drawHeat(canvas, points, w, h) {
    var scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!points.length) return;
    var radius = Math.max(10, canvas.width * 0.06);
    // each tap adds a little; many overlapping ones reach the hot end
    var alpha = Math.max(0.12, Math.min(0.5, 2.5 / Math.sqrt(points.length)));
    points.forEach(function (p) {
      var x = p[0] * canvas.width;
      var y = p[1] * canvas.height;
      var g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, "rgba(0,0,0," + alpha + ")");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    });
    var image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var px = image.data;
    for (var i = 0; i < px.length; i += 4) {
      var a = px[i + 3] / 255;
      if (!a) continue;
      // blue -> green -> yellow -> red as density rises
      var t = Math.min(1, a * 1.6);
      var r = t < 0.5 ? 0 : Math.round(255 * Math.min(1, (t - 0.5) * 2.2));
      var gr = t < 0.5 ? Math.round(255 * t * 2) : Math.round(255 * (1 - (t - 0.75) * 2.5));
      var b = t < 0.5 ? Math.round(255 * (1 - t * 2)) : 0;
      px[i] = r;
      px[i + 1] = Math.max(0, Math.min(255, gr));
      px[i + 2] = b;
      px[i + 3] = Math.round(Math.min(0.78, 0.25 + a * 1.2) * 255);
    }
    ctx.putImageData(image, 0, 0);
  }

  function hotspotAnswer(d) {
    return Array.isArray(d.answer) && d.answer.length === 3 ? d.answer : null;
  }

  // `aspect` is height / width: a y fraction times it is a share of the
  // width, the unit the radius is given in.
  function inside(p, answer, aspect) {
    var dx = p[0] - answer[0];
    var dy = (p[1] - answer[1]) * aspect;
    return Math.sqrt(dx * dx + dy * dy) <= answer[2];
  }
  LP.hotspotHit = inside;

  register("hotspot", {
    unit: "taps",
    empty: function () {
      return { points: [] };
    },
    asAnswer: function (value) {
      return { x: value[0], y: value[1] };
    },
    check: function (content) {
      var x = Number(content.x);
      var y = Number(content.y);
      if (!isFinite(x) || !isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
      return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
    },
    add: function (t, p) {
      t.points.push(p);
    },
    count: function (t) {
      return t.points.length;
    },
    wire: function (t) {
      return { points: t.points };
    },
    unwire: function (content) {
      return { points: Array.isArray(content.points) ? content.points : [] };
    },
    raw: function (t) {
      return t.points.slice();
    },
    draw: function (box, t, d, id) {
      var img = box.querySelector(".lp-hot-img");
      var canvas = box.querySelector(".lp-hot-heat");
      var svg = box.querySelector(".lp-hot-marks");
      if (!img || !canvas) return;
      if (!img.complete || !img.naturalWidth) {
        img.addEventListener("load", function () {
          this.draw(box, t, d, id);
        }.bind(this), { once: true });
        return;
      }
      var w = img.offsetWidth;
      var h = img.offsetHeight;
      if (!w || !h) return; // not on screen
      drawHeat(canvas, t.points, w, h);
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      svg.style.width = w + "px";
      svg.style.height = h + "px";
      var marks = t.points
        .map(function (p) {
          return '<circle class="lp-hot-dot" cx="' + (p[0] * w).toFixed(1) + '" cy="' + (p[1] * h).toFixed(1) + '" r="3"/>';
        })
        .join("");
      var answer = hotspotAnswer(d);
      if (answer && LP.answerShown(id)) {
        marks +=
          '<circle class="lp-hot-answer" cx="' + (answer[0] * w).toFixed(1) + '" cy="' + (answer[1] * h).toFixed(1) +
          '" r="' + (answer[2] * w).toFixed(1) + '"/>';
        var aspect = h / w;
        var hits = t.points.filter(function (p) { return inside(p, answer, aspect); }).length;
        marks +=
          '<text class="lp-hot-score" x="' + (w - 8) + '" y="' + (h - 10) + '" text-anchor="end">' +
          hits + " of " + t.points.length + " inside</text>";
      }
      svg.innerHTML = marks;
    },
  });

  /* ---------------------------------------------------------- sketch */

  // A curve is d.points y-values at evenly spaced x across d.x, null where
  // the participant drew nothing.
  function sketchX(d, i) {
    return d.x[0] + ((d.x[1] - d.x[0]) * i) / (d.points - 1);
  }

  // The answer's y at x, by straight lines between its points; null outside it.
  function answerAt(answer, x) {
    for (var i = 1; i < answer.length; i++) {
      var a = answer[i - 1], b = answer[i];
      if (x >= a[0] && x <= b[0]) return b[0] === a[0] ? a[1] : a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }
    return null;
  }

  // How far a curve is from the answer, on average, where both exist (y units);
  // null when they never overlap.
  LP.sketchError = function (curve, d) {
    if (!Array.isArray(d.answer) || d.answer.length < 2) return null;
    var sum = 0, n = 0;
    curve.forEach(function (y, i) {
      if (y === null) return;
      var want = answerAt(d.answer, sketchX(d, i));
      if (want === null) return;
      sum += Math.abs(y - want);
      n++;
    });
    return n ? sum / n : null;
  };

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // a polyline's points, broken into runs where the curve has gaps
  function runs(values, X, Y) {
    var out = [], run = [];
    values.forEach(function (v, i) {
      if (v === null || v === undefined) {
        if (run.length) out.push(run);
        run = [];
      } else run.push(X(i).toFixed(1) + "," + Y(v).toFixed(1));
    });
    if (run.length) out.push(run);
    return out;
  }

  register("sketch", {
    unit: "sketches",
    empty: function () {
      return { curves: [] };
    },
    asAnswer: function (value) {
      return { curve: value };
    },
    check: function (content, d) {
      var c = content.curve;
      if (!Array.isArray(c) || c.length !== d.points) return null;
      var out = [], drawn = 0;
      for (var i = 0; i < c.length; i++) {
        if (c[i] === null) {
          out.push(null);
          continue;
        }
        var y = Number(c[i]);
        if (typeof c[i] !== "number" || !isFinite(y)) return null;
        y = Math.max(d.y[0], Math.min(d.y[1], y));
        out.push(Math.round(y * 1000) / 1000);
        drawn++;
      }
      return drawn >= 2 ? out : null;
    },
    add: function (t, curve) {
      t.curves.push(curve);
    },
    count: function (t) {
      return t.curves.length;
    },
    wire: function (t) {
      return { curves: t.curves };
    },
    unwire: function (content) {
      return { curves: Array.isArray(content.curves) ? content.curves : [] };
    },
    raw: function (t) {
      return t.curves.slice();
    },
    draw: function (box, t, d, id) {
      var svg = box.querySelector(".lp-sketch-plot");
      var w = box.clientWidth, h = box.clientHeight;
      if (!svg || !w || !h) return; // not on screen
      var empty = box.querySelector(".lp-empty");
      if (empty) empty.hidden = t.curves.length > 0;
      var m = { l: 64, r: 16, t: 12, b: d.xLabel ? 56 : 34 };
      if (d.yLabel) m.l += 22;
      var pw = w - m.l - m.r, ph = h - m.t - m.b;
      var X = function (i) { return m.l + (pw * i) / (d.points - 1); };
      var XV = function (x) { return m.l + (pw * (x - d.x[0])) / (d.x[1] - d.x[0]); };
      var Y = function (y) { return m.t + ph * (1 - (y - d.y[0]) / (d.y[1] - d.y[0])); };
      var parts = [];

      // axes and ticks
      var tick = function (lo, hi, at, horizontal) {
        var step = niceStep(hi - lo), out = [];
        for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
          var p = at(v).toFixed(1);
          out.push(horizontal
            ? '<line class="lp-sk-grid" x1="' + p + '" x2="' + p + '" y1="' + m.t + '" y2="' + (m.t + ph) + '"/>' +
              '<text class="lp-sk-tick" x="' + p + '" y="' + (m.t + ph + 22) + '" text-anchor="middle">' + numberText(v) + "</text>"
            : '<line class="lp-sk-grid" x1="' + m.l + '" x2="' + (m.l + pw) + '" y1="' + p + '" y2="' + p + '"/>' +
              '<text class="lp-sk-tick" x="' + (m.l - 8) + '" y="' + p + '" dy="0.35em" text-anchor="end">' + numberText(v) + "</text>");
        }
        return out.join("");
      };
      parts.push(tick(d.x[0], d.x[1], XV, true), tick(d.y[0], d.y[1], Y, false));
      if (d.xLabel) parts.push('<text class="lp-sk-label" x="' + (m.l + pw / 2) + '" y="' + (h - 8) + '" text-anchor="middle">' + LP.escape(d.xLabel) + "</text>");
      if (d.yLabel) parts.push('<text class="lp-sk-label" transform="rotate(-90)" x="' + -(m.t + ph / 2) + '" y="18" text-anchor="middle">' + LP.escape(d.yLabel) + "</text>");

      // every curve, fainter the more there are
      var opacity = Math.max(0.08, Math.min(0.5, 2 / Math.sqrt(t.curves.length || 1)));
      t.curves.forEach(function (c) {
        runs(c, X, Y).forEach(function (r) {
          parts.push('<polyline class="lp-sk-curve" style="opacity:' + opacity.toFixed(2) + '" points="' + r.join(" ") + '"/>');
        });
      });

      // the class: median and middle half, where at least two drew
      if (t.curves.length >= 2) {
        var med = [], q1 = [], q3 = [];
        for (var i = 0; i < d.points; i++) {
          var col = t.curves.map(function (c) { return c[i]; })
            .filter(function (v) { return v !== null && v !== undefined; })
            .sort(function (a, b) { return a - b; });
          var enough = col.length >= 2;
          med.push(enough ? quantile(col, 0.5) : null);
          q1.push(enough ? quantile(col, 0.25) : null);
          q3.push(enough ? quantile(col, 0.75) : null);
        }
        // the band: along q3 and back along q1, for each stretch with values
        // (the quartiles and the median have gaps in the same places)
        var top = runs(q3, X, Y), bottom = runs(q1, X, Y);
        top.forEach(function (r, k) {
          parts.push('<polygon class="lp-sk-band" points="' + r.concat(bottom[k].slice().reverse()).join(" ") + '"/>');
        });
        runs(med, X, Y).forEach(function (r) {
          parts.push('<polyline class="lp-sk-median" points="' + r.join(" ") + '"/>');
        });
      }

      // the real data, once revealed
      if (Array.isArray(d.answer) && d.answer.length >= 2 && LP.answerShown(id)) {
        var pts = d.answer.map(function (p) { return XV(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1); });
        parts.push('<polyline class="lp-sk-answer" points="' + pts.join(" ") + '"/>');
        d.answer.forEach(function (p) {
          parts.push('<circle class="lp-sk-answer-dot" cx="' + XV(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) + '" r="5"/>');
        });
        if (t.curves.length) {
          var close = t.curves.filter(function (c) {
            var e = LP.sketchError(c, d);
            return e !== null && e <= d.tolerance;
          }).length;
          parts.push('<text class="lp-sk-score" x="' + (m.l + pw - 6) + '" y="' + (m.t + 20) + '" text-anchor="end">' +
            close + " of " + t.curves.length + " close</text>");
        }
      }
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      svg.innerHTML = parts.join("");
    },
  });

  // The image only has a size once it has loaded, and again after a resize.
  window.addEventListener("resize", function () {
    var slide = window.Reveal && Reveal.getCurrentSlide && Reveal.getCurrentSlide();
    if (!slide) return;
    raf(function () {
      document.dispatchEvent(new CustomEvent("livepoll-slide", { detail: { slide: slide } }));
    });
  });
})();
