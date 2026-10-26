/*****************************************************************
** livepoll — the maths of a .sketch question ("draw your guess"),
** shared by the deck (questions.js) and the phones (poll.html, which gets a
** copy beside it as livepoll-sketch.js), so both place, score and label a
** curve the same way.
**
** A question `d` (from the deck's config) has its axes' ranges d.x and d.y,
** each linear or log (d.xScale, d.yScale). A curve is d.points y-values at
** evenly spaced x on the drawn axis (so evenly spaced in log x on a log
** axis), null where nothing was drawn. Distances are measured on the drawn
** axis too, so "close" means close on the chart people see.
******************************************************************/

(function () {
  function log(scale) {
    return scale === "log";
  }

  // a value on an axis as a position along it, 0..1
  function share(range, scale, v) {
    if (log(scale)) return (Math.log10(v) - Math.log10(range[0])) / (Math.log10(range[1]) - Math.log10(range[0]));
    return (v - range[0]) / (range[1] - range[0]);
  }

  // and back
  function value(range, scale, s) {
    if (log(scale)) return Math.pow(10, Math.log10(range[0]) + s * (Math.log10(range[1]) - Math.log10(range[0])));
    return range[0] + s * (range[1] - range[0]);
  }

  var S = {
    // x and y along their axes (0..1, y upwards), and back
    sx: function (d, x) { return share(d.x, d.xScale, x); },
    sy: function (d, y) { return share(d.y, d.yScale, y); },
    yAt: function (d, s) { return value(d.y, d.yScale, Math.max(0, Math.min(1, s))); },

    // the x of curve index i, and the index nearest an x
    xOf: function (d, i) { return value(d.x, d.xScale, i / (d.points - 1)); },
    indexOf: function (d, x) {
      return Math.max(0, Math.min(d.points - 1, Math.round(share(d.x, d.xScale, x) * (d.points - 1))));
    },

    // A line through `pts` ([[x, y], ...], by x), straight on the drawn axes:
    // its y at x, or null outside it.
    lineAt: function (d, pts, x) {
      var px = S.sx(d, x);
      for (var i = 1; i < pts.length; i++) {
        var a = S.sx(d, pts[i - 1][0]), b = S.sx(d, pts[i][0]);
        if (px >= a - 1e-9 && px <= b + 1e-9) {
          var t = b === a ? 0 : (px - a) / (b - a);
          return S.yAt(d, S.sy(d, pts[i - 1][1]) + t * (S.sy(d, pts[i][1]) - S.sy(d, pts[i - 1][1])));
        }
      }
      return null;
    },

    // Where drawing starts: the last known point, else start=, else nothing.
    // { i, y }: index i is fixed at y, and nothing before it is drawn.
    anchor: function (d) {
      var p = Array.isArray(d.known) && d.known.length ? d.known[d.known.length - 1] : d.start;
      if (!Array.isArray(p)) return null;
      return { i: S.indexOf(d, p[0]), y: p[1] };
    },

    // An empty curve: nulls, but the anchor's point where there is one.
    blank: function (d) {
      var curve = [];
      for (var i = 0; i < d.points; i++) curve.push(null);
      var a = S.anchor(d);
      if (a) curve[a.i] = a.y;
      return curve;
    },

    // The part of a curve someone actually drew: after the anchor.
    drawn: function (d, curve) {
      var a = S.anchor(d);
      var n = 0;
      curve.forEach(function (v, i) {
        if (v !== null && (!a || i > a.i)) n++;
      });
      return n;
    },

    // How far a curve is from the answer, on average over what was drawn and
    // the answer covers, as a share of the y axis (0..1); null if never both.
    error: function (curve, d) {
      if (!Array.isArray(d.answer) || d.answer.length < 2) return null;
      var a = S.anchor(d);
      var sum = 0, n = 0;
      curve.forEach(function (y, i) {
        if (y === null || (a && i <= a.i)) return;
        var want = S.lineAt(d, d.answer, S.xOf(d, i));
        if (want === null) return;
        sum += Math.abs(S.sy(d, y) - S.sy(d, want));
        n++;
      });
      return n ? sum / n : null;
    },

    // ...and in the units people read: y units on a linear axis, a factor
    // ("a factor of 1.4") on a log one
    errorText: function (d, e) {
      if (e === null) return "—";
      if (log(d.yScale)) {
        var factor = Math.pow(10, e * (Math.log10(d.y[1]) - Math.log10(d.y[0])));
        return "a factor of " + S.round(factor, factor >= 10 ? 0 : 2);
      }
      var units = e * (d.y[1] - d.y[0]);
      return S.format(d, "y", units >= 10 ? Math.round(units * 10) / 10 : Math.round(units * 100) / 100);
    },

    // the most characters any y tick label has, to leave room for them
    widestY: function (d) {
      return Math.max.apply(null, S.ticks(d, "y").map(function (t) { return t.text.length; }).concat([1]));
    },

    close: function (curve, d) {
      var e = S.error(curve, d);
      return e !== null && e <= d.tolerance + 1e-9;
    },

    round: function (v, decimals) {
      return String(Math.round(v * Math.pow(10, decimals)) / Math.pow(10, decimals));
    },

    // A value as the axis labels it: its decimals, and its unit ("42%",
    // "42 ms")
    format: function (d, axis, v) {
      var decimals = d[axis + "Decimals"];
      var text;
      if (typeof decimals === "number") text = v.toFixed(decimals);
      else if (Math.abs(v) >= 1000 || v === Math.round(v)) text = String(Math.round(v));
      else if (Math.abs(v) >= 10) text = v.toFixed(1).replace(/\.0$/, "");
      else text = String(Math.round(v * 100) / 100);
      var unit = d[axis + "Unit"];
      return unit ? text + (/^[%°‰]/.test(unit) ? "" : " ") + unit : text;
    },

    // The ticks along an axis: [{ s: 0..1, text }]. x-labels name evenly
    // spaced positions; a log axis ticks its powers of ten (and 2 and 5 times
    // them when there are few); a linear one about five round steps, or
    // every x-ticks / y-ticks.
    ticks: function (d, axis) {
      var range = d[axis], scale = d[axis + "Scale"];
      var labels = axis === "x" ? d.xLabels : null;
      if (Array.isArray(labels) && labels.length) {
        return labels.map(function (text, k) {
          return { s: labels.length === 1 ? 0.5 : k / (labels.length - 1), text: text };
        });
      }
      var out = [];
      if (log(scale)) {
        var lo = Math.floor(Math.log10(range[0])), hi = Math.ceil(Math.log10(range[1]));
        var steps = hi - lo <= 2 ? [1, 2, 5] : [1];
        for (var p = lo; p <= hi; p++) {
          steps.forEach(function (m) {
            var v = m * Math.pow(10, p);
            if (v >= range[0] - 1e-9 && v <= range[1] + 1e-9) out.push({ s: share(range, scale, v), text: S.format(d, axis, v) });
          });
        }
        return out;
      }
      var step = d[axis + "Ticks"] || niceStep(range[1] - range[0]);
      for (var v = Math.ceil(range[0] / step - 1e-9) * step; v <= range[1] + 1e-9; v += step) {
        out.push({ s: share(range, scale, v), text: S.format(d, axis, Math.round(v / step) * step) });
      }
      return out;
    },
  };

  // round numbers for an axis: about five steps across a span
  function niceStep(span) {
    var raw = span / 5;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  window.LivepollSketch = S;
})();
