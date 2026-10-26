// Draw your guess: phones draw curves, the deck overlays them with the class
// median, and the real data is revealed, scored and exported.
const { sleep, launch, openHost, openPhone, gotoSlide, check } = require("./lib");

// Draws y = f(share of the way along x) on the phone's chart, whose box and
// margins (sketchBox) come from the page; this question's y runs 200..600.
async function draw(p, f) {
  const r = await p.$eval("#sketchSvg", (s) => { const b = s.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; });
  const k = await p.evaluate(() => sketchBox(cfg.sketches[active.id]));
  const pw = k.w - k.l - k.r, ph = k.h - k.t - k.b;
  const at = (fx) => ({
    x: r.l + ((k.l + pw * fx) / k.w) * r.w,
    y: r.t + ((k.t + ph * (1 - (f(fx) - 200) / 400)) / k.h) * r.h,
  });
  const start = at(0);
  await p.mouse.move(start.x, start.y);
  await p.mouse.down();
  for (let k = 1; k <= 25; k++) {
    const q = at(k / 25);
    await p.mouse.move(q.x, q.y);
  }
  await p.mouse.up();
}
// the real data, by straight lines between 20:250 40:280 60:340 80:450
const truth = (fx) => {
  const x = 20 + 60 * fx, pts = [[20, 250], [40, 280], [60, 340], [80, 450]];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (x - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0]);
  return 450;
};

(async () => {
  const browser = await launch();
  try {
    const host = await openHost(browser, "test4.html");
    const phones = [];
    for (let i = 0; i < 2; i++) {
      const p = await openPhone(browser, "test4.html");
      await p.waitForSelector("#nickSkip");
      await p.click("#nickSkip");
      phones.push(p);
    }
    const [a, b] = phones;
    await gotoSlide(host, "Draw your guess");
    for (const p of phones) await p.waitForSelector("#sketchSvg");
    check(await a.$eval("#sketchSubmit", (s) => s.disabled), "submit waits until something is drawn");

    await draw(a, (fx) => truth(fx) + 12); // close
    await draw(b, () => 560); // flat, far off
    check(!(await a.$eval("#sketchSubmit", (s) => s.disabled)), "submit enabled after drawing");
    check((await a.$$eval("#sketchSvg .mine", (l) => l.length)) >= 1, "phone shows its own curve");
    const drawn = await a.evaluate(() => { const v = document.getElementById("sketchSvg").innerHTML; return v.length; });
    for (const p of phones) await p.click("#sketchSubmit");
    await sleep(900);

    const count = await host.$eval('.sketch-voters[data-sketch="rt"]', (e) => e.textContent);
    check(count === "2", "deck counts two sketches: " + count);
    const curves = await host.$$eval('.lp-sketch[data-sketch="rt"] .lp-sk-curve', (c) => c.length);
    check(curves >= 2, "deck overlays every curve: " + curves);
    check((await host.$$eval(".lp-sk-median", (m) => m.length)) >= 1, "deck draws the class median");
    check((await host.$$eval(".lp-sk-band", (m) => m.length)) >= 1, "and the middle-half band");
    check((await host.$$eval(".lp-sk-answer", (m) => m.length)) === 0, "real data hidden before the reveal");
    check(/Age/.test(await host.$eval(".lp-sketch-plot", (s) => s.textContent)), "axis label drawn (" + drawn + ")");

    // a second submission from the same phone is refused
    await a.evaluate(() => socket.emit("message", { venue: config.url, name: config.room, hash: config.hash, recipient: true,
      content: { sender: "sketch", type: "answer", id: "rt", curve: new Array(40).fill(300), device } }));
    await sleep(700);
    check((await host.$eval('.sketch-voters[data-sketch="rt"]', (e) => e.textContent)) === "2", "a second sketch from one phone is refused");

    // reveal
    await host.evaluate(() => Reveal.next());
    await sleep(1200);
    check((await host.$$eval(".lp-sk-answer", (m) => m.length)) === 1, "real data drawn on reveal");
    const score = await host.$eval(".lp-sk-score", (s) => s.textContent);
    check(score === "1 of 2 close", "deck says how many were close: " + score);
    const va = await a.$eval("#answerBox", (e) => e.textContent);
    const vb = await b.$eval("#answerBox", (e) => e.textContent);
    check(/✅ Close/.test(va), "close phone told it was close: " + va.replace(/\s+/g, " ").slice(0, 80));
    check(/❌ Off by/.test(vb), "far phone told how far off: " + vb.replace(/\s+/g, " ").slice(0, 80));
    check((await a.$$eval("#sketchSvg .truth", (t) => t.length)) === 1, "phone draws the real data over its curve");
    check(/\+\d+/.test(await a.$eval("#toast", (e) => e.textContent)), "close sketch scores quiz points");
    check(/No points/.test(await b.$eval("#toast", (e) => e.textContent)), "far sketch scores none");

    await host.screenshot({ path: require("./lib").OUT + "shots/sketch-deck.png" });
    await a.screenshot({ path: require("./lib").OUT + "shots/sketch-phone.png", fullPage: true });

    // export
    const exported = await host.evaluate(async () => (await window.plateSession.build()).sketches);
    check(exported.length === 1 && exported[0].answers.length === 2 && exported[0].answers[0].length === 40,
      "session.json has both curves: " + JSON.stringify(exported.map((e) => [e.id, e.answers.length])));

    for (const [n, p] of [["host", host], ["a", a], ["b", b]]) check(p.errors.length === 0, n + " has no errors: " + p.errors.join(" | "));
  } catch (e) {
    console.log("FAIL: exception", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
