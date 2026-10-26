const { BASE, sleep, launch, openHost, gotoSlide, check } = require("./lib");
const tally = (h, id) => h.$$eval(`.livepoll-question[data-poll="${id}"] .lp-row`, (r) => r.map((x) => x.dataset.value + "=" + x.querySelector(".lp-n").textContent).join(" "));
(async () => {
  const browser = await launch();
  try {
    const host = await openHost(browser, "index.html");
    await gotoSlide(host, "Which language do you use most?");
    await host.click('.livepoll-question[data-poll="lang"] .lp-row[data-value="B"]');
    await sleep(800);
    check((await tally(host, "lang")) === "A=0 B=0 C=0 D=0", "the presenter's click is not a vote");
    check(await host.$eval('.lp-row[data-value="B"]', (b) => getComputedStyle(b).cursor === "default"), "bars do not look clickable on the presenting deck");
    const p = await host.browserContext().newPage();
    await p.setViewport({ width: 390, height: 844 });
    p.on("dialog", (d) => d.dismiss());
    await p.goto(BASE + "poll.html", { waitUntil: "networkidle0" });
    await p.waitForSelector("#nickSkip", { timeout: 10000 }); await p.click("#nickSkip");
    await p.waitForSelector('#pollOptions button[data-value="A"]');
    await p.click('#pollOptions button[data-value="A"]');
    await sleep(1000);
    check((await tally(host, "lang")) === "A=1 B=0 C=0 D=0", "a phone in the presenter's own browser is counted: " + (await tally(host, "lang")));
    // a repeat from the same device is refused, and the phone is told
    await p.evaluate(() => socket.emit("message", { venue: config.url, name: config.room, hash: config.hash, recipient: true,
      content: { sender: "poll-plugin", type: "vote", poll: "lang", choice: "C", device } }));
    await sleep(800);
    check(/Not counted/.test(await p.$eval("#status", (e) => e.textContent)), "a refused repeat is reported on the phone");
    check((await tally(host, "lang")) === "A=1 B=0 C=0 D=0", "and not counted");
    check(host.errors.length === 0, "no errors " + host.errors.join("|"));
  } catch (e) { console.log("FAIL", e); process.exitCode = 1; } finally { await browser.close(); }
})();
