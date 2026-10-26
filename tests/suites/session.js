const fs = require("fs");
const { BASE, sleep, launch, newPage, openPhone, gotoSlide, check } = require("./lib");
const { OUT } = require("./lib");

async function hostIn(ctx) {
  const page = await ctx.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.goto(BASE + "test.html", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.Reveal && Reveal.isReady());
  return page;
}
async function startHosting(page) {
  await page.evaluate(() => RevealSeminar.open_or_join_room("test", "Lecturer"));
  await page.waitForFunction(() => RevealSeminar.hosting());
}

(async () => {
  const browser = await launch();
  try {
    const ctx = await browser.createBrowserContext();
    let host = await hostIn(ctx);
    await startHosting(host);
    const a = await openPhone(browser), b = await openPhone(browser);
    for (const p of [a, b]) { await p.waitForSelector("#nickSkip"); await p.click("#nickSkip"); }

    await gotoSlide(host, "Which language do you use most?");
    await a.waitForSelector('#pollOptions button[data-value="C"]');
    await a.click('#pollOptions button[data-value="C"]');
    await gotoSlide(host, "Guess the mean");
    await a.waitForSelector("#estimateInput");
    await a.type("#estimateInput", "33");
    await a.click("#estimateSubmit");
    await b.waitForSelector("#estimateInput");
    await b.type("#estimateInput", "48");
    await b.click("#estimateSubmit");
    await a.click("#tabAsk");
    await a.type("#askText", "What is a confidence interval, really?");
    await a.click("#askForm button[type=submit]");
    await b.click('[data-signal="lost"]');
    await sleep(1800);

    // --- autosave written
    const saved = await host.evaluate(() => JSON.parse(localStorage.getItem("livepoll-autosave:" + location.pathname) || "null"));
    check(saved && saved.responses === 4 && !saved.exported, "autosave has 4 responses, not exported: " + (saved && saved.responses));

    // --- speaker view HUD
    await host.evaluate(() => Reveal.getPlugin("notes").open());
    await sleep(2500);
    const hud = await host.evaluate(() => {
      const w = window.open("", "reveal.js - Notes");
      const el = w && w.document.getElementById("livepoll-hud");
      return el ? el.textContent : null;
    });
    check(hud && /mean/.test(hud) && /1 lost/.test(hud) && /confidence interval/.test(hud), "speaker view shows HUD: " + (hud || "").slice(0, 160));

    // --- export
    const session = await host.evaluate(() => window.plateSession.build());
    fs.writeFileSync(OUT + "session-test.json", JSON.stringify(session, null, 2));
    check(session.polls.length === 1 && session.polls[0].id === "lang", "export has lang poll");
    check(session.estimates.length === 1 && session.estimates[0].answers.join() === "33,48", "export has estimate answers: " + JSON.stringify(session.estimates));
    check(session.responses.length === 4 && session.responses[0].participant === "p1", "responses pseudonymised p1..: " + JSON.stringify(session.responses[0]));
    check(session.questions.length === 1 && session.questions[0].by === "p1", "question recorded with asker id");
    check(session.signals.length === 1 && session.signals[0].kind === "lost", "signal logged");
    check(session.opened.lang && session.opened.mean, "opened times recorded");
    const csv = await host.evaluate(() => window.plateSession.csv());
    const lines = csv.trim().split("\n");
    check(lines.length === 5 && /^time,seconds_since_open,kind/.test(lines[0]), "CSV has header + 4 rows");
    check(/,poll,lang,Which language do you use most\?,1,p1,C,Julia/.test(csv), "CSV row has label: " + lines[1]);

    // --- crash: close without unloading, reopen
    const before = await host.evaluate(() => document.querySelector('.voters[data-poll="lang"]').textContent);
    await host.close({ runBeforeUnload: false });
    await sleep(1000);
    host = await hostIn(ctx);
    await host.waitForSelector("#livepoll-restore", { timeout: 5000 });
    const banner = await host.$eval("#livepoll-restore", (e) => e.textContent);
    check(/4 responses/.test(banner), "restore offered: " + banner);
    await host.click('#livepoll-restore button[data-act="restore"]');
    await sleep(500);
    const after = await host.evaluate(() => document.querySelector('.voters[data-poll="lang"]').textContent);
    check(after === before && after === "1", "lang voters restored: " + after);
    const est = await host.evaluate(() => document.querySelector('.estimate-voters[data-estimate="mean"]').textContent);
    check(est === "2", "estimate restored: " + est);
    await startHosting(host);
    // the phones were dropped when the room closed; they rejoin by themselves
    for (const p of [a, b]) await p.waitForFunction(() => joined, { timeout: 15000 });
    await sleep(800);

    // a phone that already voted stays locked (same session id), a new vote adds on
    await gotoSlide(host, "Which language do you use most?");
    await sleep(800);
    const aLocked = await a.$eval('#pollOptions button[data-value="C"]', (x) => x.disabled && x.classList.contains("selected"));
    check(aLocked, "phone that voted before the crash is still locked");
    // and a forged repeat from it is refused (device remembered through the restore)
    await a.evaluate(() => socket.emit("message", { venue: config.url, name: config.room, hash: config.hash, recipient: true,
      content: { sender: "poll-plugin", type: "vote", poll: "lang", choice: "A", device } }));
    await b.waitForSelector('#pollOptions button[data-value="A"]');
    await b.click('#pollOptions button[data-value="A"]');
    await sleep(800);
    const tally = await host.$$eval('.livepoll-question[data-poll="lang"] .lp-row', (r) => r.map((x) => x.dataset.value + "=" + x.querySelector(".lp-n").textContent).join(" "));
    check(tally === "A=1 B=0 C=1", "restored tally continues: " + tally);
    const qa = await b.evaluate(() => { document.getElementById("tabAsk").click(); return document.querySelectorAll(".qa-item").length; });
    check(qa === 1, "Q&A restored and resent to phones: " + qa);

    // --- export marks clean
    await host.evaluate(() => window.plateSession.export());
    await sleep(1500);
    const clean = await host.evaluate(() => JSON.parse(localStorage.getItem("livepoll-autosave:" + location.pathname)).exported);
    check(clean === true, "export marks autosave as saved");
    const full = await host.evaluate(() => window.plateSession.build());
    fs.writeFileSync(OUT + "session.json", JSON.stringify(full, null, 2));

    for (const [name, p] of [["host", host], ["a", a], ["b", b]]) {
      check(p.errors.length === 0, name + " has no errors: " + p.errors.join(" | "));
    }
  } catch (e) {
    console.log("FAIL: exception", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
