/*
 * RevealSession — record what happened in the room.
 *
 * A deck carries state that exists only while the class is running:
 *
 *   polls      the tallies live in the *presenter's* browser, in a closure
 *              inside poll.js. Nothing writes them anywhere. Close the tab and
 *              the vote is gone.
 *   clouds     the same for word-cloud counts, kept by livepoll.js.
 *   drawings   if the deck uses the Excalidraw overlay, its scene is kept in
 *              localStorage (only when useLocalStorage is on) and otherwise
 *              only in memory.
 *
 * This plugin watches all three and, on Alt+R, downloads a session.json. Put
 * that file next to the deck's .qmd and re-render: livepoll.lua replays the
 * poll and cloud results on the slides. See the README for the file's shape.
 *
 * Nothing here modifies livepoll or excalidraw: it listens to the events poll.js
 * and livepoll.js already dispatch and reads the key excalidraw already writes.
 * If either goes quiet the export still succeeds and simply reports having
 * found nothing.
 */

window.RevealSession = window.RevealSession || {
  id: "RevealSession",
  init: function (deck) {
    initSession(deck);
  },
};

const initSession = function (Reveal) {
  const config = Reveal.getConfig().session || {};
  const shortcut = (config.shortcut || "s").toLowerCase();
  const filename = config.filename || "session.json";

  // -------------------------------------------------------------- polls

  // id -> { question, options: [{value, label, correct}], votes: {}, voters }
  const polls = {};

  // livepoll writes every poll's question, options and correct answer into a
  // JSON block in <head> — the same block poll.html configures itself from. It
  // is the better source than the DOM, because it is there whether or not the
  // deck happens to carry a `.poll-results` slide: without one there is no
  // `.poll-answer` element, and reading the correct answer from the DOM alone
  // would silently stop marking it in the handout.
  function deckConfig() {
    const el = document.getElementById("livepoll-config");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (error) {
      console.warn("session: could not parse the livepoll config block —", error);
      return null;
    }
  }

  function readPollDefinitions() {
    const config = deckConfig();

    document.querySelectorAll(".poll[data-poll]").forEach(function (el) {
      const id = el.getAttribute("data-poll");
      if (!id || polls[id]) return;

      const declared = config && config.polls ? config.polls[id] : null;

      const options = [];
      el.querySelectorAll("button[data-value]").forEach(function (button) {
        options.push({
          value: button.getAttribute("data-value"),
          // A panel-layout button also holds its bar and count, so its text is
          // "A. label 3 25%"; it carries the bare label in data-label.
          label: button.getAttribute("data-label") || button.textContent.trim(),
          correct: false,
        });
      });

      // The correct answer, from the config block if the deck has one and from
      // the `.poll-answer` reveal otherwise — that element only exists when a
      // `.poll-results` block was written, so it cannot be the only source.
      let correctValue = declared ? declared.correct : null;
      if (!correctValue) {
        const answer = document.querySelector('.poll-answer[data-poll="' + cssEscape(id) + '"]');
        correctValue = answer ? answer.getAttribute("data-correct") : null;
      }
      if (correctValue) {
        options.forEach(function (option) {
          if (option.value === correctValue) option.correct = true;
        });
      }

      // livepoll writes the question into an h3 beside the buttons; when the
      // slide already carries it as a heading there is no such element, and the
      // config block or the slide title stands in.
      const heading = document.querySelector('.poll-question[data-poll="' + cssEscape(id) + '"]');

      polls[id] = {
        question: (declared && declared.question) || (heading ? heading.textContent.trim() : null),
        slide: slideIdOf(el),
        options: options,
        votes: {},
        voters: 0,
      };
    });
  }

  // poll.js broadcasts every tally as it changes. `broadcast` is what the host
  // sends, `received` what a participant gets — listening to both means the
  // export works from either machine, though only the host sees a full count.
  function onPollMessage(event) {
    const content = event && event.content;
    if (!content || content.sender !== "poll-plugin") return;

    const poll = polls[content.poll];
    if (!poll) return;

    if (content.type === "results" && content.votes) {
      poll.votes = Object.assign({}, content.votes);
    } else if (content.type === "voters") {
      poll.voters = content.voters;
    }
  }

  document.addEventListener("broadcast", onPollMessage);
  document.addEventListener("received", onPollMessage);

  // -------------------------------------------------------- word clouds

  // id -> { question, slide, counts: { word: n } }
  const clouds = {};

  function readCloudDefinitions() {
    const config = deckConfig();

    document.querySelectorAll(".wordcloud[data-wordcloud]").forEach(function (el) {
      const id = el.getAttribute("data-wordcloud");
      if (!id || clouds[id]) return;

      const declared = config && config.clouds ? config.clouds[id] : null;
      const heading = document.querySelector(
        '.poll-question[data-wordcloud="' + cssEscape(id) + '"]'
      );

      clouds[id] = {
        question: (declared && declared.question) || (heading ? heading.textContent.trim() : null),
        slide: slideIdOf(el),
        counts: {},
      };
    });
  }

  // Same event stream as the polls, under a different sender. `clear` matters:
  // wiping a cloud mid-class and starting again should not leave the old words
  // in the export.
  function onCloudMessage(event) {
    const content = event && event.content;
    if (!content || content.sender !== "wordcloud-plugin") return;

    const cloud = clouds[content.cloud];
    if (!cloud) return;

    if (content.type === "counts" && content.counts) {
      cloud.counts = Object.assign({}, content.counts);
    } else if (content.type === "clear") {
      cloud.counts = {};
    }
  }

  document.addEventListener("broadcast", onCloudMessage);
  document.addEventListener("received", onCloudMessage);

  // ------------------------------------------------------------ likert

  // id -> { question, slide, statements, labels, counts, voters }. The
  // definition comes from the config block; the slide is the one holding the
  // question (the classic results chart may sit on another).
  const likerts = {};

  function readLikertDefinitions() {
    const config = deckConfig();
    const declared = (config && config.likerts) || {};
    Object.keys(declared).forEach(function (id) {
      if (likerts[id]) return;
      const el = document.querySelector('.likert[data-likert="' + cssEscape(id) + '"]');
      likerts[id] = {
        question: declared[id].question,
        slide: el ? slideIdOf(el) : null,
        statements: declared[id].statements,
        labels: declared[id].labels,
        counts: null,
        voters: 0,
      };
    });
  }

  function onLikertMessage(event) {
    const content = event && event.content;
    if (!content || content.sender !== "likert-plugin" || content.type !== "counts") return;
    const likert = likerts[content.likert];
    if (!likert || !Array.isArray(content.counts)) return;
    likert.counts = content.counts.map(function (row) {
      return row.slice();
    });
    likert.voters = content.voters || 0;
  }

  document.addEventListener("broadcast", onLikertMessage);
  document.addEventListener("received", onLikertMessage);

  // ----------------------------------------------------------- drawings

  // The Excalidraw overlay is a single scene for the whole deck, so an element
  // carries no record of which slide it was drawn over. We reconstruct that:
  // every time the slide changes, whatever ids are new since the last look were
  // drawn on the slide we are leaving.
  const elementSlide = {}; // excalidraw element id -> reveal slide id
  let lastSlideId = null;

  function storageKey() {
    return "excalidraw-data-" + window.location.pathname;
  }

  function readScene() {
    try {
      const raw = window.localStorage.getItem(storageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.elements) ? parsed : null;
    } catch (error) {
      console.warn("session: could not read the Excalidraw scene —", error);
      return null;
    }
  }

  function attributeNewElements(toSlideId) {
    const scene = readScene();
    if (!scene) return;

    scene.elements.forEach(function (element) {
      if (element && element.id && !elementSlide[element.id]) {
        elementSlide[element.id] = toSlideId;
      }
    });
  }

  Reveal.addEventListener("slidechanged", function () {
    // Attribute to the slide being *left*, which is where the drawing happened.
    attributeNewElements(lastSlideId);
    lastSlideId = currentSlideId();
  });

  // --------------------------------------------------------------- util

  function currentSlideId() {
    const slide = Reveal.getCurrentSlide();
    return slide ? slide.id || null : null;
  }

  function slideIdOf(el) {
    const section = el.closest("section");
    return section ? section.id || null : null;
  }

  // CSS.escape is not in every browser a lecture room might have; ids here come
  // from Pandoc and are already [a-z0-9-], so a conservative filter is enough.
  function cssEscape(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function slideTitles() {
    const titles = {};
    document.querySelectorAll(".slides section[id]").forEach(function (section) {
      const heading = section.querySelector("h1, h2, h3");
      titles[section.id] = heading ? heading.textContent.trim() : null;
    });
    return titles;
  }

  // ------------------------------------------------------------- export

  // Excalidraw ships its own exporter; the bundle publishes it as ExcalidrawLib.
  // Rendering each slide's subset separately is what turns one shared canvas
  // into per-slide figures.
  async function renderDrawings() {
    const scene = readScene();
    if (!scene || scene.elements.length === 0) return [];

    if (typeof ExcalidrawLib === "undefined" || !ExcalidrawLib.exportToBlob) {
      console.warn("session: ExcalidrawLib.exportToBlob is unavailable — skipping drawings.");
      return [];
    }

    // Anything drawn on the current slide has not been attributed yet.
    attributeNewElements(currentSlideId());

    const bySlide = {};
    scene.elements.forEach(function (element) {
      if (element.isDeleted) return;
      const slide = elementSlide[element.id] || "unattributed";
      (bySlide[slide] = bySlide[slide] || []).push(element);
    });

    const titles = slideTitles();
    const drawings = [];

    for (const slide of Object.keys(bySlide)) {
      const elements = bySlide[slide];

      // Two attempts. The first asks for what the handout actually wants: no
      // background, and 2x so the PNG stays sharp when a slide-width drawing is
      // scaled down to a ~16 cm text block. The second asks for nothing but a
      // PNG.
      //
      // The fallback is not defensiveness for its own sake — exportToBlob's
      // optional arguments have moved between Excalidraw versions, and this
      // bundle is whatever `quarto add` last fetched. A rejected option would
      // otherwise lose the whole drawing, and the place you find out is a
      // handout with nothing in it, hours after the class.
      let blob = null;
      try {
        blob = await ExcalidrawLib.exportToBlob({
          elements: elements,
          files: scene.files || {},
          mimeType: "image/png",
          quality: 1,
          exportPadding: 8,
          appState: {
            exportWithDarkMode: false,
            exportBackground: false,
            exportScale: 2,
          },
        });
      } catch (error) {
        console.warn("session: full-quality export failed for", slide, "— retrying plainly.", error);
        try {
          blob = await ExcalidrawLib.exportToBlob({
            elements: elements,
            files: scene.files || {},
            mimeType: "image/png",
          });
        } catch (retryError) {
          console.warn("session: could not export the drawing for slide", slide, retryError);
        }
      }

      if (blob) {
        drawings.push({
          slide: slide === "unattributed" ? null : slide,
          title: titles[slide] || null,
          png: await blobToDataUri(blob),
        });
      }
    }

    return drawings;
  }

  function blobToDataUri(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function buildSession() {
    readPollDefinitions();
    readCloudDefinitions();
    readLikertDefinitions();

    // counts[statement][point], in the deck's order; an unanswered scale is
    // left out like an unopened poll
    const recordedLikerts = [];
    Object.keys(likerts).forEach(function (id) {
      const likert = likerts[id];
      if (!likert.counts || !likert.voters) return;
      recordedLikerts.push({
        id: id,
        slide: likert.slide,
        question: likert.question,
        statements: likert.statements,
        labels: likert.labels,
        voters: likert.voters,
        counts: likert.counts,
      });
    });

    const recordedClouds = [];
    Object.keys(clouds).forEach(function (id) {
      const cloud = clouds[id];
      const words = Object.keys(cloud.counts);

      // An untouched cloud is left out, same as an unopened poll.
      if (words.length === 0) return;

      recordedClouds.push({
        id: id,
        slide: cloud.slide,
        question: cloud.question,
        // Most frequent first, so the handout can be read top-down and the
        // rendering does not have to care about order.
        words: words
          .map(function (word) {
            return { word: word, count: cloud.counts[word] };
          })
          .sort(function (a, b) {
            return b.count - a.count || a.word.localeCompare(b.word);
          }),
      });
    });

    const recorded = [];
    Object.keys(polls).forEach(function (id) {
      const poll = polls[id];
      const total = Object.keys(poll.votes).reduce(function (sum, key) {
        return sum + (poll.votes[key] || 0);
      }, 0);

      // A poll nobody voted in is left out rather than printed as a row of
      // zeroes — it usually means the poll was never opened.
      if (total === 0) return;

      recorded.push({
        id: id,
        slide: poll.slide,
        question: poll.question,
        voters: poll.voters || total,
        options: poll.options.map(function (option) {
          return {
            label: option.label,
            correct: option.correct,
            votes: poll.votes[option.value] || 0,
          };
        }),
      });
    });

    return {
      version: 1,
      deck: window.location.pathname.replace(/\/index\.html$|\/$/, "").split("/").pop() || null,
      recorded: new Date().toISOString(),
      // Which exporter wrote this. Reveal plugins are served from site_libs at a
      // stable URL with no cache-busting, so a browser that has had the deck open
      // since before a rebuild will keep running the old script and quietly
      // export a file missing whatever was added since. Stamping the version
      // turns that into something the reading end can name.
      generator: "session.js/1.2",
      polls: recorded,
      clouds: recordedClouds,
      likerts: recordedLikerts,
      drawings: await renderDrawings(),
    };
  }

  async function exportSession() {
    let session;
    try {
      session = await buildSession();
    } catch (error) {
      console.error("session: export failed —", error);
      window.alert("Session export failed — see the browser console.");
      return;
    }

    const url = URL.createObjectURL(
      new Blob([JSON.stringify(session, null, 2)], { type: "application/json" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    console.log(
      "session: exported " +
        session.polls.length +
        " poll(s), " +
        session.clouds.length +
        " word cloud(s), " +
        session.likerts.length +
        " rating scale(s) and " +
        session.drawings.length +
        " drawing(s)."
    );
  }

  // Capture phase, and stopImmediatePropagation on a match.
  //
  // Reveal binds its own shortcuts on a bubble-phase listener and matches on the
  // key alone, without looking at modifiers — so Alt+S opened the speaker notes
  // as well as exporting, because as far as Reveal is concerned that was just S.
  // Listening in the capture phase means this runs first, and stopping
  // propagation there keeps the event from ever reaching Reveal.
  //
  // That is what makes the choice of key safe rather than lucky: whatever
  // `session.shortcut` is set to, nothing else will also act on it.
  document.addEventListener(
    "keydown",
    function (event) {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (!event.key || event.key.toLowerCase() !== shortcut) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      exportSession();
    },
    true
  );

  // Also reachable from the console, which is the honest way to check what a
  // class produced before trusting the file.
  window.plateSession = { export: exportSession, build: buildSession };

  Reveal.addEventListener("ready", function () {
    readPollDefinitions();
    readCloudDefinitions();
    readLikertDefinitions();
    lastSlideId = currentSlideId();
  });
};
