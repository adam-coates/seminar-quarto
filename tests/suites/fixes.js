const { BASE, sleep, launch, newPage, openHost, openPhone, gotoSlide, check } = require("./lib");
const names = (page) => page.$$eval(".lp-leaderboard .lp-leader-name", (n) => n.map((x) => x.textContent).join(","));
const toast = (p) => p.$eval("#toast", (e) => e.textContent);
(async () => {
  const browser = await launch();
  try {
    // ---- 4: honest phone status
    const deck = await newPage(browser, { viewport: { width: 1400, height: 900 } });
    await deck.goto(BASE + "test.html", { waitUntil: "networkidle0" });
    const early = await newPage(browser, { viewport: { width: 390, height: 844 } });
    await early.goto(BASE + "poll.html?deck=test.html", { waitUntil: "networkidle0" });
    await sleep(2500);
    const st = await early.$eval("#status", (e) => e.className + ": " + e.textContent);
    check(/^offline: Not connected/.test(st), "phone says not connected before the presenter starts: " + st);

    // ---- 3: start from the speaker view
    await deck.evaluate(() => Reveal.getPlugin("notes").open());
    await sleep(3000);
    const speaker = (await browser.pages()).find((p) => p.frames().some((f) => /receiver/.test(f.url())));
    const frame = speaker.frames().filter((f) => /receiver/.test(f.url()))[0];
    await frame.evaluate(() => { document.getElementById("password").value = "test"; document.getElementById("username").value = "Adam"; document.getElementById("startSeminar").click(); });
    await sleep(2500);
    check(await deck.evaluate(() => RevealSeminar.hosting()), "Start in the speaker view makes the presentation window host");
    check(!(await frame.evaluate(() => RevealSeminar.hosting())), "the preview itself does not host");
    check(/Lecturer|Adam|host room/.test(await frame.$eval("#logger", (e) => e.value)), "preview's status log mirrors the presentation window");
    await gotoSlide(deck, "Quick quiz"); // a 3 s timer poll
    await sleep(500);
    await early.waitForSelector("#nickSkip", { timeout: 8000 }); await early.click("#nickSkip");
    await early.waitForSelector('#pollOptions button[data-value="B"]', { timeout: 8000 });
    check(true, "the early phone gets the poll");
    const st2 = await early.$eval("#status", (e) => e.className);
    check(st2 !== "offline", "phone no longer says not connected");
    // Shift+T in the preview pauses the presentation window's timer
    await frame.focus("body").catch(() => {});
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "T", shiftKey: true, bubbles: true, cancelable: true })));
    await sleep(400);
    check(await deck.$eval('.lp-timer[data-timer="quick"]', (e) => e.classList.contains("lp-timer-paused")), "Shift+T in the preview pauses the timer");
    // a panel button in the preview: Close voting acts on the presentation window
    await frame.evaluate(() => document.getElementById("closePoll").click());
    await sleep(700);
    check(/closed/.test(await deck.$eval("#livepoll-live", (e) => e.textContent)), "Close voting from the preview closes it");
    await frame.evaluate(() => document.getElementById("reopenPoll").click());
    await sleep(700);
    await sleep(1200);
    check(/Questions|quick/.test(await frame.$eval("#livepoll-live", (e) => e.textContent)), "preview mirrors the live display");

    // ---- 1 & 2: quiz board and scoring
    await deck.evaluate(() => { const t = document.querySelector('.lp-timer[data-timer="quick"]'); });
    const host = deck;
    const a = early;
    await gotoSlide(host, "Peer instruction"); // 20 s timer, rounds: 2, answer B
    const b = await openPhone(browser);
    await b.waitForSelector("#nickInput"); await b.type("#nickInput", "Late Bo"); await b.click("#nickForm button[type=submit]");
    await sleep(1200);
    await gotoSlide(host, "Leaderboard");
    await sleep(600);
    check(/Late Bo/.test(await names(host)), "a late joiner is on the leaderboard straight away: " + (await names(host)));
    await gotoSlide(host, "Peer instruction");
    await a.waitForSelector('#pollOptions button[data-value="B"]');
    await a.click('#pollOptions button[data-value="B"]');
    await sleep(400);
    // advance too far: round 2 step, then the answer, before Bo has voted in round 2
    await host.evaluate(() => Reveal.next());
    await sleep(500);
    await a.click('#pollOptions button[data-value="B"]');
    await host.evaluate(() => Reveal.next());
    await sleep(900);
    const aFirst = await toast(a);
    check(/\+\d+/.test(aFirst), "A scored at the premature reveal: " + aFirst);
    // step back: the reveal and its points are taken back
    await host.evaluate(() => Reveal.prev());
    await sleep(900);
    const aBack = await a.$eval("#me", (e) => e.textContent);
    check(/ 0 pts/.test(aBack), "A's points are taken back with the reveal: " + aBack);
    // Bo votes late, then the answer is revealed for real
    await b.waitForSelector('#pollOptions button[data-value="B"]');
    await b.click('#pollOptions button[data-value="B"]');
    await sleep(500);
    await host.evaluate(() => Reveal.next());
    await sleep(1000);
    const bToast = await toast(b);
    check(/\+\d+/.test(bToast), "Bo, who voted after the mistake, is scored: " + bToast);
    const aMe = await a.$eval("#me", (e) => e.textContent);
    const aPts = Number((aMe.match(/(\d+) pts/) || [])[1]);
    check(aPts > 0 && aPts <= 1000, "A scored once, not twice: " + aMe);
    await gotoSlide(host, "Leaderboard");
    await sleep(600);
    const scores = await host.$$eval(".lp-leader-score", (s) => s.map((x) => Number(x.textContent)));
    check(scores.filter((x) => x > 0).length === 2, "both have points on the board: " + scores.join(","));
    for (const [n, p] of [["host", host], ["a", a], ["b", b]]) check(p.errors.length === 0, n + " no errors " + p.errors.join(" | "));
    check(frame && true, "done");
  } catch (e) { console.log("FAIL", e); process.exitCode = 1; } finally { await browser.close(); }
})();
