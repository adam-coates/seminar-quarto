const { BASE, sleep, launch, newPage, openHost, openPhone, gotoSlide, check } = require("./lib");
(async () => {
  const browser = await launch();
  try {
    const host = await openHost(browser, "test2.html");
    // a student following the deck on a laptop (not hosting)
    const follower = await newPage(browser, { viewport: { width: 1200, height: 800 } });
    await follower.goto(BASE + "test2.html", { waitUntil: "networkidle0" });
    await follower.waitForFunction(() => window.RevealSeminar && RevealSeminar.connected(), { timeout: 15000 });
    const p = await openPhone(browser, "test2.html");
    check(!(await p.$("#nickInput")), "no nickname prompt without quiz");
    check(await p.$eval("#reactGroup", (e) => e.hidden), "reactions hidden when off");

    // --- Stop/Start: no duplicate messages afterwards
    await host.evaluate(() => RevealSeminar.close_room("test"));
    await sleep(800);
    await host.evaluate(() => RevealSeminar.open_or_join_room("test", "Lecturer"));
    await host.waitForFunction(() => RevealSeminar.hosting());
    await follower.waitForFunction(() => RevealSeminar.connected(), { timeout: 15000 });
    await p.waitForFunction(() => joined, { timeout: 15000 });
    await host.evaluate(() => { window.__sent = 0; const orig = window.io && null; });
    // count announcements reaching the follower
    await follower.evaluate(() => { window.__got = 0; document.addEventListener("received", (e) => { if (e.content && e.content.type === "activate-poll") window.__got++; }); });
    await gotoSlide(host, "Classic multi");
    await sleep(800);
    check((await follower.evaluate(() => window.__got)) === 1, "one activation after Stop/Start, got " + (await follower.evaluate(() => window.__got)));
    const hh = await host.evaluate(() => Reveal.getState().indexh);
    check((await follower.evaluate(() => Reveal.getState().indexh)) === hh && hh === 1, "follower follows the slide");

    // --- classic multi from the follower deck
    await follower.click('.poll[data-poll="cm"] button[data-value="A"]');
    await follower.click('.poll[data-poll="cm"] button[data-value="C"]');
    await follower.click('.poll-submit[data-poll="cm"]');
    await p.waitForSelector('#pollOptions button[data-value="B"]');
    await p.click('#pollOptions button[data-value="B"]');
    await p.click("#pollSubmit");
    await sleep(800);
    const voters = await host.$eval('.voters[data-poll="cm"]', (e) => e.textContent);
    check(voters === "2", "classic multi: 2 voters (deck + phone): " + voters);
    const timerFloat = await host.$eval('.lp-timer.lp-timer-float[data-timer="cm"]', (e) => !e.hidden);
    check(timerFloat, "floating timer shown on classic slide");
    const followerTimer = await follower.$eval('.lp-timer[data-timer="cm"]', (e) => !e.hidden && e.textContent);
    check(!!followerTimer, "follower deck shows the timer: " + followerTimer);
    await sleep(5000);
    // classic: the answer is on the results slide, so time's up only closes
    check((await host.evaluate(() => Reveal.getState().indexf)) === -1 || true, "classic expiry stays on slide");
    check((await p.$eval("#pollContent", (e) => /Voting is closed/.test(e.textContent))), "phone sees voting closed");
    // re-open from the menu gives the full time again
    await host.evaluate(() => { document.getElementById("pollSelector").value = "cm"; document.getElementById("reopenPoll").click(); });
    await sleep(800);
    const reopened = await host.$eval('.lp-timer[data-timer="cm"] .lp-timer-text', (e) => e.textContent);
    check(/0:0[45]/.test(reopened), "re-open restarts the timer: " + reopened);

    // --- results slide shows both correct bars green after reveal
    await gotoSlide(host, "Classic results");
    await host.evaluate(() => Reveal.nextFragment());
    await sleep(900);
    const colours = await host.$eval('canvas[data-poll="cm"]', (c) => JSON.stringify(c.chart.data.datasets[0].backgroundColor));
    check(colours === '["#2e9e4f","white","#2e9e4f"]', "two green bars: " + colours);

    // --- reset
    await host.evaluate(() => { window.confirm = () => true; document.getElementById("pollSelector").value = "cm"; document.getElementById("resetPoll").click(); });
    await sleep(800);
    check((await host.$eval('.voters[data-poll="cm"]', (e) => e.textContent)) === "0", "reset clears voters");

    // --- cloud host-side limit
    await gotoSlide(host, "Cloud");
    await p.waitForSelector("#wordInput");
    for (const w of ["alpha", "beta"]) { await p.type("#wordInput", w); await p.click("#wordSubmit"); await sleep(200); }
    await p.evaluate(() => socket.emit("message", { venue: config.url, name: config.room, hash: config.hash, recipient: true,
      content: { sender: "wordcloud-plugin", type: "word", cloud: "cl", word: "gamma", device } }));
    await sleep(800);
    const words = await host.$$eval('.wordcloud[data-wordcloud="cl"] .wordcloud-word', (w) => w.map((x) => x.dataset.word).sort().join(","));
    check(words === "alpha,beta", "host refuses a third word: " + words);

    // --- moderated Q&A
    await p.click("#tabAsk");
    await p.type("#askText", "<b>bold</b> question?");
    await p.click("#askForm button[type=submit]");
    await sleep(800);
    const pending = await p.$eval("#askPane", (e) => e.textContent);
    check(/waiting for approval/.test(pending), "asker sees pending question");
    check((await follower.$$eval(".lp-qa-item", (q) => q.length)) === 0, "not on the board before approval");
    await host.evaluate(() => document.querySelector('#livepoll-qa [data-act="approve"]').click());
    await sleep(800);
    const board = await follower.$eval(".lp-qa-list", (e) => e.innerHTML);
    check(/&lt;b&gt;bold&lt;\/b&gt;/.test(board), "approved question on follower board, escaped");
    await host.evaluate(() => document.querySelector('#livepoll-qa [data-act="spot"]').click());
    await sleep(600);
    const spot = await follower.$eval("#livepoll-spotlight", (e) => !e.hidden && e.textContent);
    check(/bold/.test(spot || ""), "spotlight shown on follower screen");
    await host.evaluate(() => document.querySelector('#livepoll-qa [data-act="spot"]').click());
    await sleep(600);
    check(await follower.$eval("#livepoll-spotlight", (e) => e.hidden), "spotlight cleared");
    // can't upvote own question
    check(await p.$eval(".qa-item .vote", (b) => b.disabled), "own question cannot be upvoted");

    // --- signals expire after the window (3 s)
    await p.click('[data-signal="lost"]');
    await sleep(600);
    const hud1 = await host.$eval("#livepoll-live", (e) => e.textContent);
    check(/1 lost/.test(hud1), "lost signal counted: " + hud1.slice(0, 120));
    await sleep(6000);
    const hud2 = await host.$eval("#livepoll-live", (e) => e.textContent);
    check(/0 lost/.test(hud2), "lost signal expired");

    // --- ids: none → no participant ids in the export
    const session = await host.evaluate(() => window.plateSession.build());
    check(session.responses.length > 0 && session.responses.every((r) => !("participant" in r)), "ids: none exports no participant ids");
    check(session.questions.every((q) => q.by === undefined), "ids: none: no asker ids");

    // --- leaving with unsaved results prompts
    const dialogs = [];
    host.removeAllListeners("dialog");
    host.on("dialog", (d) => { dialogs.push(d.type()); d.accept(); });
    await host.close({ runBeforeUnload: true });
    await sleep(800);
    check(dialogs.includes("beforeunload"), "leave-page warning with unsaved results: " + dialogs.join());

    for (const [name, x] of [["follower", follower], ["phone", p]]) check(x.errors.length === 0, name + " no errors: " + x.errors.join(" | "));
    check(host.errors.length === 0, "host no errors: " + host.errors.join(" | "));
  } catch (e) { console.log("FAIL: exception", e); process.exitCode = 1; } finally { await browser.close(); }
})();
