// The word filter: flagged words, questions and nicknames never reach the
// projector or other screens unless the presenter approves them.
const { BASE, sleep, launch, newPage, openHost, openPhone, gotoSlide, check } = require("./lib");

const cloudWords = (page, id) =>
  page.$$eval('.wordcloud[data-wordcloud="' + id + '"] .wordcloud-word', (w) => w.map((x) => x.dataset.word).sort().join(","));
const held = (host) =>
  host.$$eval("#livepoll-cloud-moderation .livepoll-qa-item", (items) =>
    items.map((i) => (i.querySelector('[title="Matched the word filter"]') ? "⚠" : "") + i.querySelector(".livepoll-qa-text").textContent).sort().join(","));
// click a button in the held-words item whose text starts with `word`
const decide = (host, word, act) =>
  host.evaluate((word, act) => {
    const item = [...document.querySelectorAll("#livepoll-cloud-moderation .livepoll-qa-item")]
      .find((i) => i.querySelector(".livepoll-qa-text").textContent.trim().startsWith(word));
    item.querySelector('[data-act="' + act + '"]').click();
  }, word, act);
async function sendWords(p, words) {
  await p.waitForSelector("#wordInput");
  for (const w of words) {
    await p.type("#wordInput", w);
    await p.click("#wordSubmit");
    await sleep(250);
  }
}

(async () => {
  const browser = await launch();
  try {
    // --- filter on: blocked-words [Kevin], allowed-words Dick
    const host = await openHost(browser, "test4.html");
    const follower = await newPage(browser, { viewport: { width: 1200, height: 800 } });
    await follower.goto(BASE + "test4.html", { waitUntil: "networkidle0" });
    await follower.waitForFunction(() => window.RevealSeminar && RevealSeminar.connected(), { timeout: 15000 });

    // nicknames
    const p = await openPhone(browser, "test4.html");
    await p.waitForSelector("#nickInput");
    await p.type("#nickInput", "Arschloch");
    await p.click("#nickForm button[type=submit]");
    const q = await openPhone(browser, "test4.html");
    await q.waitForSelector("#nickInput");
    await q.type("#nickInput", "Ada");
    await q.click("#nickForm button[type=submit]");
    await sleep(800);
    const nicks = await host.$$eval(".livepoll-quiz-nick", (n) => n.map((x) => x.textContent).sort().join(","));
    check(/^Ada,Player \d+$/.test(nicks), "flagged nickname replaced, clean one kept: " + nicks);
    check(/Player \d+/.test(await p.$eval("#me", (e) => e.textContent)), "the player is told their neutral name");

    // word cloud
    await gotoSlide(host, "Cloud");
    await sendWords(p, ["hello", "f*ck", "Kevin", "Dick", "Scunthorpe", "FUCK!"]);
    await sleep(800);
    check((await cloudWords(host, "fc")) === "dick,hello,scunthorpe", "only clean words on the projector: " + (await cloudWords(host, "fc")));
    check((await cloudWords(follower, "fc")) === "dick,hello,scunthorpe", "and on a follower's screen: " + (await cloudWords(follower, "fc")));
    check((await held(host)) === "⚠f*ck,⚠fuck!,⚠kevin", "flagged words held, marked: " + (await held(host)));
    const hud = await host.evaluate(() => (document.getElementById("livepoll-live") || {}).textContent || "");
    check(/3 words to approve/.test(hud), "presenter display counts them: " + hud);

    await decide(host, "kevin", "reject");
    await sleep(600);
    check(!/kevin/.test(await held(host)) && !/kevin/.test(await cloudWords(host, "fc")), "rejected word gone, never shown");
    await decide(host, "f*ck", "approve");
    await sleep(800);
    check((await cloudWords(follower, "fc")) === "dick,f*ck,hello,scunthorpe", "approved word reaches every screen: " + (await cloudWords(follower, "fc")));

    // questions
    await gotoSlide(host, "Questions");
    await q.click("#tabAsk");
    await q.type("#askText", "Why is this shit so hard?");
    await q.click("#askForm button[type=submit]");
    await sleep(400);
    await q.type("#askText", "What is a p-value?");
    await q.click("#askForm button[type=submit]");
    await sleep(900);
    const board = await follower.$$eval(".lp-qa-item", (i) => i.map((x) => x.textContent).join(" | "));
    check(/p-value/.test(board) && !/shit/.test(board), "clean question shown, flagged one held: " + board);
    const flaggedItem = await host.$$eval('#livepoll-qa .livepoll-qa-item[data-status="pending"]', (i) =>
      i.map((x) => (x.querySelector('[title="Matched the word filter"]') ? "⚠" : "") + x.querySelector(".livepoll-qa-text").textContent));
    check(flaggedItem.length === 1 && /^⚠Why is this shit/.test(flaggedItem[0]), "held question marked for the presenter: " + flaggedItem);

    // --- wordcloud: moderated, filter off: everything waits
    const host2 = await openHost(browser, "test5.html");
    const r = await openPhone(browser, "test5.html");
    await gotoSlide(host2, "Moderated cloud");
    await sendWords(r, ["alpha", "beta", "alpha"]);
    await sleep(800);
    check((await cloudWords(host2, "mc")) === "", "moderated cloud shows nothing before approval");
    check((await held(host2)) === "alpha,beta", "held unflagged, identical words together: " + (await held(host2)));
    check(/×2/.test(await host2.$eval("#livepoll-cloud-moderation", (e) => e.textContent)), "duplicate shown as ×2");
    await host2.evaluate(() => document.querySelector('#livepoll-cloud-moderation [data-act="approve-unflagged"]').click());
    await sleep(800);
    check((await cloudWords(host2, "mc")) === "alpha,beta", "approve all adds them: " + (await cloudWords(host2, "mc")));
    check(/Nothing waiting/.test(await host2.$eval("#livepoll-cloud-moderation", (e) => e.textContent)), "queue empty afterwards");
    const n = await host2.evaluate(() => Livepoll.kinds.wordcloud.count("mc").n);
    check(n === 3, "both alphas counted once approved: " + n + " words");

    for (const [name, page] of [["host", host], ["follower", follower], ["phone p", p], ["phone q", q], ["host2", host2], ["phone r", r]]) {
      check(page.errors.length === 0, name + " has no errors: " + page.errors.join(" | "));
    }
  } catch (e) {
    console.log("FAIL: exception", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
