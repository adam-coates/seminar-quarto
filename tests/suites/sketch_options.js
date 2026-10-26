// The sketch's options: log axes, labels and units, start / known data,
// what the class sees (show, band, hide-until-reveal) and the look.
const { sleep, launch, openHost, openPhone, gotoSlide, check } = require("./lib");

// Draws on the phone's chart from shares of the axes: fy = f(fx), both 0..1
// along the drawn axes, from fx = from to fx = to.
async function draw(p, from, to, f) {
  const r = await p.$eval("#sketchSvg", (s) => { const b = s.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; });
  const k = await p.evaluate(() => sketchBox(cfg.sketches[active.id]));
  const pw = k.w - k.l - k.r, ph = k.h - k.t - k.b;
  const at = (fx) => ({ x: r.l + ((k.l + pw * fx) / k.w) * r.w, y: r.t + ((k.t + ph * (1 - f(fx))) / k.h) * r.h });
  const s = at(from);
  await p.mouse.move(s.x, s.y);
  await p.mouse.down();
  for (let n = 1; n <= 20; n++) { const q = at(from + ((to - from) * n) / 20); await p.mouse.move(q.x, q.y); }
  await p.mouse.up();
}
const texts = (page, sel) => page.$$eval(sel, (t) => t.map((x) => x.textContent));
const exported = async (host, id) =>
  ((await host.evaluate(async () => (await window.plateSession.build()).sketches)) || []).find((e) => e.id === id);

(async () => {
  const browser = await launch();
  try {
    const host = await openHost(browser, "test4.html");
    const phones = [];
    for (let i = 0; i < 3; i++) {
      const p = await openPhone(browser, "test4.html");
      await p.waitForSelector("#nickSkip");
      await p.click("#nickSkip");
      phones.push(p);
    }

    // --- log y, weekday labels, units, start, median only, 80% band, hidden until the reveal
    await gotoSlide(host, "Sketch with options");
    const box = '.lp-sketch[data-sketch="growth"]';
    const ticks = await texts(host, box + " .lp-sk-tick");
    check(["10 users", "100 users", "1000 users", "10000 users"].every((t) => ticks.includes(t)), "log y ticks in powers of ten, with the unit: " + ticks.filter((t) => /users/.test(t)).join(","));
    check(["Mon", "Thu", "Sun"].every((t) => ticks.includes(t)), "x-labels on the x axis");
    const style = await host.$eval(box, (b) => b.getAttribute("style"));
    check(/--lp-sk-line:#d33/.test(style) && /--lp-sk-answer:#06c/.test(style) && /--lp-sk-font:18px/.test(style), "colours and font size set: " + style);
    // offsetHeight: in the slide's own pixels, before reveal.js scales it to the window
    const height = await host.$eval(box, (b) => b.offsetHeight);
    check(Math.abs(height - 380) < 2, "height=380px: " + height);
    check(await host.$eval('.livepoll-question[data-sketch="growth"]', (q) => q.classList.contains("lp-results-hidden")), "hide-until-reveal hides the class's curves");
    check((await host.$$eval(box + " .lp-sk-known-dot", (d) => d.length)) === 1, "start point drawn on the slide");

    for (const p of phones) await p.waitForSelector("#sketchSvg");
    check((await phones[0].$$eval("#sketchSvg .known-dot", (d) => d.length)) === 1, "phone shows the start point");
    // each starts drawing a third of the way along: the line joins the start point
    const lines = [(fx) => 0.25 + 0.7 * fx, (fx) => 0.2 + 0.75 * fx, (fx) => 0.6];
    for (let i = 0; i < 3; i++) {
      await draw(phones[i], 0.33, 1, lines[i]);
      await phones[i].click("#sketchSubmit");
    }
    await sleep(900);
    const growth = await exported(host, "growth");
    const first = growth.answers[0];
    check(first[0] === 10 && first.slice(0, 14).every((v) => v !== null), "curve starts at the start point and joins it: " + first.slice(0, 4).join(","));
    check((await host.$$eval(box + " .lp-sk-curve", (c) => c.length)) === 0, "show=median: no individual curves");
    check((await host.$$eval(box + " .lp-sk-median", (c) => c.length)) >= 1, "the median is drawn (under the veil)");
    check((await host.$$eval(box + " .lp-sk-band", (c) => c.length)) >= 1, "the 80% band is drawn");

    await host.evaluate(() => Reveal.next());
    await sleep(1200);
    check(!(await host.$eval('.livepoll-question[data-sketch="growth"]', (q) => q.classList.contains("lp-results-hidden"))), "the reveal shows the class");
    check((await host.$$eval(box + " .lp-sk-answer", (a) => a.length)) === 1, "real data drawn");
    const color = await host.$eval(box + " .lp-sk-answer", (a) => getComputedStyle(a).stroke);
    check(color === "rgb(0, 102, 204)", "answer-color used: " + color);
    const v = await phones[2].$eval("#answerBox", (e) => e.textContent.replace(/\s+/g, " "));
    check(/ff by a factor of [\d.]+ on average/.test(v), "log axis: off by a factor: " + v.slice(-50));

    // --- known data, curves only, no band, y-ticks, decimals and a % unit
    await gotoSlide(host, "Sketch from known data");
    const kbox = '.lp-sketch[data-sketch="known"]';
    check((await host.$$eval(kbox + " .lp-sk-known", (k) => k.length)) === 1, "known data drawn on the slide before any answer");
    const yt = await texts(host, kbox + " .lp-sk-tick");
    check(["0.0%", "25.0%", "50.0%", "75.0%", "100.0%"].every((t) => yt.includes(t)), "y-ticks=25, y-decimals=1, % unit: " + yt.filter((t) => /%/.test(t)).join(","));
    for (const p of phones) await p.waitForSelector("#sketchSvg .known");
    check(true, "phones show the known data");
    // starting before the known data ends: clamped to after it
    await draw(phones[0], 0.05, 1, (fx) => 0.4 + 0.5 * fx);
    await draw(phones[1], 0.3, 1, (fx) => 0.45 + 0.4 * fx);
    for (const p of phones.slice(0, 2)) await p.click("#sketchSubmit");
    await sleep(900);
    const known = await exported(host, "known");
    const c0 = known.answers[0];
    check(c0.slice(0, 8).every((x) => x === null) && c0[8] === 40 && c0[9] !== null, "nothing before the known data; drawing starts from its end: " + c0.slice(6, 11).join(","));
    check((await host.$$eval(kbox + " .lp-sk-curve", (c) => c.length)) >= 2, "show=curves: individual curves");
    check((await host.$$eval(kbox + " .lp-sk-median", (c) => c.length)) === 0, "no median");
    check((await host.$$eval(kbox + " .lp-sk-band", (c) => c.length)) === 0, "band=none: no band");
    await host.evaluate(() => Reveal.next());
    await sleep(1200);
    const kv = await phones[1].$eval("#answerBox", (e) => e.textContent.replace(/\s+/g, " "));
    check(/ff by [\d.]+% on average/.test(kv), "error in the axis's unit: " + kv.slice(-45));

    await host.screenshot({ path: require("./lib").OUT + "shots/sketch-known-deck.png" });
    await gotoSlide(host, "Sketch with options");
    await host.screenshot({ path: require("./lib").OUT + "shots/sketch-log-deck.png" });
    await phones[0].screenshot({ path: require("./lib").OUT + "shots/sketch-known-phone.png", fullPage: true });
    for (const [n, p] of [["host", host], ...phones.map((p, i) => ["phone " + i, p])]) check(p.errors.length === 0, n + " has no errors: " + p.errors.join(" | "));
  } catch (e) {
    console.log("FAIL: exception", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
