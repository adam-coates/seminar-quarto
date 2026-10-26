const { sleep, launch, openHost, openPhone, gotoSlide, check } = require("./lib");

const votes = (page, id) =>
  page.$$eval(`.livepoll-question[data-poll="${id}"] .lp-row`, (rows) =>
    rows.map((r) => r.getAttribute("data-value") + "=" + r.querySelector(".lp-n").textContent).join(" ")
  );

(async () => {
  const browser = await launch();
  try {
    const host = await openHost(browser);
    // nickname prompt appears (quiz: true); skip it
    const p1 = await openPhone(browser);
    const p2 = await openPhone(browser);
    for (const p of [p1, p2]) {
      await p.waitForSelector("#nickSkip", { timeout: 5000 });
      await p.click("#nickSkip");
    }

    // --- single choice, dedupe across reload
    await gotoSlide(host, "Which language do you use most?");
    await p1.waitForSelector('#pollOptions button[data-value="B"]');
    await p1.click('#pollOptions button[data-value="B"]');
    await sleep(600);
    await p1.reload({ waitUntil: "networkidle0" });
    await sleep(1500);
    const lockedAfterReload = await p1.$eval('#pollOptions button[data-value="B"]', (b) => b.disabled && b.classList.contains("selected"));
    check(lockedAfterReload, "phone stays locked (and shows its choice) after reload");
    // a forged second vote from the same device over a new socket is refused by the host
    await p1.evaluate(() => {
      socket.emit("message", { venue: config.url, name: config.room, hash: config.hash, recipient: true,
        content: { sender: "poll-plugin", type: "vote", poll: "lang", choice: "A", device } });
    });
    await p2.waitForSelector('#pollOptions button[data-value="A"]');
    await p2.click('#pollOptions button[data-value="A"]');
    await sleep(800);
    check((await votes(host, "lang")) === "A=1 B=1 C=0", "lang tally A=1 B=1 (reload+forged device refused): " + (await votes(host, "lang")));

    // --- forged results from a participant must not change the projector
    await p2.evaluate(() => {
      socket.emit("message", { venue: config.url, name: config.room, hash: config.hash,
        content: { sender: "poll-plugin", type: "results", poll: "lang", votes: { A: 99, B: 0, C: 0 } } });
    });
    await sleep(600);
    check((await votes(host, "lang")) === "A=1 B=1 C=0", "forged results message ignored by host");

    // --- multi-select
    await gotoSlide(host, "Pick the primes");
    await p1.waitForSelector('#pollOptions button[data-value="A"]');
    for (const v of ["A", "B", "D"]) await p1.click(`#pollOptions button[data-value="${v}"]`);
    // fourth pick refused (max 3)
    await p1.click('#pollOptions button[data-value="C"]');
    const picked = await p1.$$eval("#pollOptions button.selected", (b) => b.length);
    check(picked === 3, "phone caps picks at 3, got " + picked);
    await p1.click("#pollSubmit");
    await p2.waitForSelector('#pollOptions button[data-value="C"]');
    await p2.click('#pollOptions button[data-value="C"]');
    await p2.click("#pollSubmit");
    await sleep(800);
    check((await votes(host, "primes")) === "A=1 B=1 C=1 D=1", "multi tally: " + (await votes(host, "primes")));
    const pct = await host.$eval('.livepoll-question[data-poll="primes"] .lp-row[data-value="A"] .lp-pct', (e) => e.textContent);
    check(pct === "50%", "multi % is of respondents (1 of 2 = 50%), got " + pct);
    // reveal answer: step to fragment
    await host.evaluate(() => Reveal.nextFragment());
    await sleep(800);
    const correctRows = await host.$$eval('.livepoll-question[data-poll="primes"] .lp-row.lp-correct', (r) => r.map((x) => x.dataset.value).join(""));
    check(correctRows === "ABD", "three correct rows highlighted: " + correctRows);
    const p1Verdict = await p1.$eval("#answerBox", (e) => e.textContent);
    check(/You were right/.test(p1Verdict), "p1 told they were right: " + p1Verdict.trim());
    const p2Verdict = await p2.$eval("#answerBox", (e) => e.textContent);
    check(/You answered/.test(p2Verdict), "p2 told they were wrong");

    // --- rounds
    await gotoSlide(host, "Peer instruction");
    await p1.waitForSelector('#pollOptions button[data-value="A"]');
    await p1.click('#pollOptions button[data-value="A"]');
    await p2.waitForSelector('#pollOptions button[data-value="B"]');
    await p2.click('#pollOptions button[data-value="B"]');
    await sleep(600);
    const timerShown = await host.$eval('.livepoll-question[data-poll="peer"] .lp-timer', (e) => !e.hidden && e.textContent.trim());
    check(!!timerShown, "timer ring shown on slide: " + timerShown);
    const phoneTimer = await p1.$eval("#timer", (e) => !e.hidden && document.getElementById("timerText").textContent);
    check(!!phoneTimer, "timer bar shown on phone: " + phoneTimer);
    await host.evaluate(() => Reveal.nextFragment()); // round 2 step
    await sleep(900);
    const r2 = await p1.$eval(".round-banner", (e) => e.textContent);
    check(/Round 2/.test(r2) && /3% chance H0 is true/.test(r2), "phone shows round 2 with previous answer: " + r2.trim().slice(0, 80));
    await p1.click('#pollOptions button[data-value="B"]');
    await sleep(800);
    check((await votes(host, "peer")) === "A=0 B=1 C=0", "round 2 tally fresh: " + (await votes(host, "peer")));
    const was = await host.$eval('.livepoll-question[data-poll="peer"] .lp-row[data-value="A"] .lp-was', (e) => e.textContent);
    check(/round 1: 50%/.test(was), "row shows round 1 share: " + was);
    const badge = await host.$eval('.livepoll-question[data-poll="peer"] .lp-round-badge', (e) => e.textContent);
    check(badge === "Round 2", "round badge: " + badge);

    // --- late joiner gets the active poll in round 2
    const p3 = await openPhone(browser);
    await p3.waitForSelector("#nickSkip");
    await p3.click("#nickSkip");
    await p3.waitForSelector(".round-banner", { timeout: 5000 });
    check(true, "late joiner sees round 2");

    // --- classic multi from a following deck isn't tested here; check submit exists
    const submit = await host.$('.poll-submit[data-poll="classicmulti"]');
    check(!!submit, "classic multi-select poll has a Submit button");

    for (const [name, p] of [["host", host], ["p1", p1], ["p2", p2], ["p3", p3]]) {
      check(p.errors.length === 0, name + " has no errors: " + p.errors.join(" | "));
    }
  } catch (e) {
    console.log("FAIL: exception", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
