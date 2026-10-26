const { sleep, launch, openHost, openPhone, gotoSlide, check } = require("./lib");

(async () => {
  const browser = await launch();
  try {
    const host = await openHost(browser);
    const phones = [];
    for (const nick of ["Ada", "Bo", ""]) {
      const p = await openPhone(browser);
      await p.waitForSelector("#nickInput");
      if (nick) {
        await p.type("#nickInput", nick);
        await p.click("#nickForm button[type=submit]");
      } else await p.click("#nickSkip");
      phones.push(p);
    }
    const [a, b, c] = phones;
    await sleep(500);

    // --- timer expiry closes voting and reveals the answer; quiz scores it
    await gotoSlide(host, "Quick quiz");
    await a.waitForSelector('#pollOptions button[data-value="B"]');
    await a.click('#pollOptions button[data-value="B"]'); // right, fast
    await b.waitForSelector('#pollOptions button[data-value="A"]');
    await b.click('#pollOptions button[data-value="A"]'); // wrong
    await sleep(4200);
    const closedOnC = await c.$eval("#pollContent", (e) => /Voting is closed|Correct answer/.test(e.textContent));
    check(closedOnC, "phone that did not vote sees voting closed / answer");
    const revealed = await host.$eval('.livepoll-question[data-poll="quick"] .lp-row[data-value="B"]', (r) => r.classList.contains("lp-correct"));
    check(revealed, "timer expiry stepped to the answer on the slide");
    const pill = await host.$eval('.livepoll-question[data-poll="quick"] .lp-pill', (e) => e.textContent);
    check(pill === "CLOSED", "pill shows CLOSED after time's up: " + pill);
    // late vote refused by host
    await c.evaluate(() => socket.emit("message", { venue: config.url, name: config.room, hash: config.hash, recipient: true,
      content: { sender: "poll-plugin", type: "vote", poll: "quick", choice: "B", device } }));
    await sleep(500);
    const n = await host.$eval('.voters[data-poll="quick"]', (e) => e.textContent);
    check(n === "2", "vote after close refused, voters=" + n);
    const toastA = await a.$eval("#toast", (e) => e.textContent);
    check(/\+\d+/.test(toastA) && /1st/.test(toastA), "Ada gets points and 1st place: " + toastA);
    const toastB = await b.$eval("#toast", (e) => e.textContent);
    check(/No points/.test(toastB), "Bo gets no points: " + toastB);

    // --- estimate
    await gotoSlide(host, "Guess the mean");
    for (const [p, v] of [[a, "40"], [b, "70"], [c, "44"]]) {
      await p.waitForSelector("#estimateInput");
      await p.click("#estimateInput", { clickCount: 3 });
      await p.type("#estimateInput", v);
      await p.click("#estimateSubmit");
    }
    await sleep(900);
    const est = await host.$eval('.lp-estimate[data-estimate="mean"] .lp-est-summary', (e) => e.textContent);
    check(/3 answers/.test(est) && /median 44/.test(est), "estimate summary: " + est);
    const bars = await host.$$eval('.lp-estimate[data-estimate="mean"] .lp-est-bar', (b) => b.length);
    check(bars > 5, "estimate histogram has bars: " + bars);
    await host.evaluate(() => Reveal.nextFragment());
    await sleep(800);
    const ans = await host.$eval('.lp-estimate[data-estimate="mean"] .lp-est-answer', (e) => !e.hidden && e.textContent);
    check(/answer 42/.test(ans), "answer line shown: " + ans);
    const est2 = await host.$eval('.lp-estimate[data-estimate="mean"] .lp-est-summary', (e) => e.textContent);
    check(/2 within ±5/.test(est2), "within tolerance count: " + est2);
    const aEst = await a.$eval("#answerBox", (e) => e.textContent);
    check(/2 too low/.test(aEst), "Ada told she was 2 too low: " + aEst);

    // --- out of range estimate refused
    await gotoSlide(host, "Open estimate");
    await a.waitForSelector("#estimateInput");
    await a.type("#estimateInput", "300");
    await a.click("#estimateSubmit");
    await sleep(700);
    const openEst = await host.$eval('.estimate-voters[data-estimate="jelly"]', (e) => e.textContent);
    check(openEst === "1", "open-range estimate counted: " + openEst);

    // --- rank
    await gotoSlide(host, "Rank the topics");
    const rankIt = async (p, order) => {
      await p.waitForSelector("#rankList button");
      for (const i of order) await p.click(`#rankList button[data-item="${i}"]`);
      await p.click("#rankSubmit");
    };
    await rankIt(a, [2, 0, 1]);
    await rankIt(b, [2, 1, 3]);
    await rankIt(c, [0, 2, 3]);
    await sleep(900);
    const order = await host.$$eval('.lp-rank[data-rank="topics"] .lp-rank-row', (rows) =>
      rows.map((r) => [Number(getComputedStyle(r).getPropertyValue("--lp-place")), r.querySelector(".lp-rank-label").textContent])
        .sort((x, y) => x[0] - y[0]).map((x) => x[1]).join(">"));
    // points: Bayes 3+3+2=8, Regression 2+0+3=5, Power 1+2=3, Bootstrap 1+1=2
    check(order === "Bayes>Regression>Power>Bootstrap", "rank order: " + order);

    // --- hotspot
    await gotoSlide(host, "Find the outlier");
    const tap = async (p, fx, fy) => {
      await p.waitForSelector("#hotFrame img");
      await p.waitForFunction(() => document.querySelector("#hotFrame img").naturalWidth > 0);
      const box = await (await p.$("#hotFrame")).boundingBox();
      await p.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await p.click("#hotSubmit");
    };
    await tap(a, 0.71, 0.32);
    await tap(b, 0.2, 0.8);
    await sleep(1000);
    const dots = await host.$$eval('.lp-hotspot[data-hotspot="outlier"] .lp-hot-dot', (d) => d.length);
    check(dots === 2, "two taps drawn: " + dots);
    await host.evaluate(() => Reveal.nextFragment());
    await sleep(800);
    const score = await host.$eval('.lp-hotspot[data-hotspot="outlier"] .lp-hot-score', (e) => e.textContent);
    check(/1 of 2 inside/.test(score), "hotspot hits: " + score);
    const aHot = await a.$eval("#answerBox", (e) => e.textContent);
    check(/right/.test(aHot), "Ada's tap inside: " + aHot);

    // --- leaderboard
    await gotoSlide(host, "Leaderboard");
    const board = await host.$$eval(".lp-leaderboard .lp-leader-name", (n) => n.map((x) => x.textContent).join(","));
    check(/^Ada,/.test(board), "leaderboard top is Ada: " + board);
    await host.screenshot({ path: require("./lib").OUT + "shots/leader.png" });

    for (const [name, p] of [["host", host], ["a", a], ["b", b], ["c", c]]) {
      check(p.errors.length === 0, name + " has no errors: " + p.errors.join(" | "));
    }
  } catch (e) {
    console.log("FAIL: exception", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
