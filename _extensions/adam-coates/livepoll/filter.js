/*****************************************************************
** livepoll — the word filter.
**
** Checks what participants type before the projector can show it: word-cloud
** words, Q&A questions and quiz nicknames. Nothing is deleted on its say:
** a flagged word or question waits for the presenter's approval, a flagged
** nickname becomes "Player N". The lists are vendor/wordlists.js (English and
** German) plus the deck's own `blocked-words`, less its `allowed-words`.
**
** Matching is by whole word (or whole phrase), after folding case, accents,
** look-alike characters (sh1t, a$$) and stretched letters (fuuuck), with `*`
** standing for any one letter (f*ck). Whole words keep "Scunthorpe",
** "assessment" and "analysis" clear of the words inside them.
******************************************************************/

(function () {
  if (/print-pdf/gi.test(window.location.search)) return;
  var LP = window.Livepoll;

  var LOOKALIKE = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s", "!": "i", "€": "e" };

  // Lower case, no accents (ä → a, ß → ss), look-alike digits mapped; anything
  // else that is not a letter, digit or `*` separates words. `symbols` reads
  // @ $ ! € as letters too (a$$), or else as the punctuation they usually are
  // (FUCK!): text is checked both ways.
  function words(text, symbols) {
    return String(text || "")
      .toLowerCase()
      .replace(/ß/g, "ss")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(symbols ? /[0134578@$!€]/g : /[0134578]/g, function (c) {
        return LOOKALIKE[c];
      })
      .split(/[^a-z0-9*À-￿]+/)
      .filter(Boolean);
  }

  var lists = null; // { single: { word: true }, phrases: ["two words", ...], allowed: { ... } }

  function build() {
    var cfg = LP.config().filter || {};
    var source = window.LivepollWordlists || {};
    var all = [];
    (cfg.languages || ["en", "de"]).forEach(function (lang) {
      all = all.concat(source[lang] || []);
    });
    all = all.concat(cfg.blocked || []);
    lists = { single: {}, phrases: [], allowed: {} };
    (cfg.allowed || []).forEach(function (w) {
      lists.allowed[words(w, true).join(" ")] = true;
    });
    all.forEach(function (entry) {
      var key = words(entry, true).join(" ");
      if (!key || lists.allowed[key]) return;
      if (key.indexOf(" ") < 0) lists.single[key] = true;
      else lists.phrases.push(key);
    });
  }

  // The ways a typed word might be written: as typed, and with letters held
  // down for three or more repeats squeezed to one or two (fuuuck, asssss).
  function spellings(word) {
    var out = [word];
    if (/(.)\1\1/.test(word)) {
      out.push(word.replace(/(.)\1{2,}/g, "$1"));
      out.push(word.replace(/(.)\1{2,}/g, "$1$1"));
    }
    return out;
  }

  // f*ck, sh*t: each * one letter, the rest as typed
  function masked(word) {
    if (word.indexOf("*") < 0 || word.replace(/\*/g, "").length < 2) return null;
    var pattern = new RegExp("^" + word.replace(/\*/g, "[a-z]") + "$");
    for (var w in lists.single) if (pattern.test(w)) return w;
    return null;
  }

  function matchWords(typed) {
    if (!typed.length || lists.allowed[typed.join(" ")]) return null;
    for (var i = 0; i < typed.length; i++) {
      if (lists.allowed[typed[i]]) continue;
      var forms = spellings(typed[i]);
      for (var j = 0; j < forms.length; j++) if (lists.single[forms[j]]) return forms[j];
      var hidden = masked(typed[i]);
      if (hidden) return hidden;
    }
    var joined = " " + typed.join(" ") + " ";
    for (var k = 0; k < lists.phrases.length; k++) {
      if (joined.indexOf(" " + lists.phrases[k] + " ") >= 0) return lists.phrases[k];
    }
    // written as one word: "blowjob" for "blow job"
    var squashed = typed.join("");
    if (typed.length > 1 && lists.single[squashed]) return squashed;
    return null;
  }

  // The first listed word or phrase in `text`, or null.
  function match(text) {
    if (!lists) build();
    return matchWords(words(text, true)) || matchWords(words(text, false));
  }

  LP.filter = {
    on: function () {
      return (LP.config().filter || {}).on !== false;
    },
    // true when the filter is on and `text` contains a listed word
    flags: function (text) {
      return LP.filter.on() && match(text) !== null;
    },
    match: match,
  };
})();
