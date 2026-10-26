const { sleep, launch, openHost, openPhone, gotoSlide, check } = require("./lib");
(async () => {
  const browser = await launch();
  try {
    const host = await openHost(browser);
    const a = await openPhone(browser), b = await openPhone(browser);
    for (const p of [a, b]) { await p.waitForSelector("#nickSkip"); await p.click("#nickSkip"); }
    await gotoSlide(host, "Peer instruction");
    await a.waitForSelector('#pollOptions button[data-value="A"]'); await a.click('#pollOptions button[data-value="A"]'); // wrong
    await b.waitForSelector('#pollOptions button[data-value="B"]'); await b.click('#pollOptions button[data-value="B"]'); // right
    await sleep(500);
    await host.evaluate(() => Reveal.nextFragment()); // round 2
    await sleep(800);
    await a.click('#pollOptions button[data-value="B"]'); // now right
    await b.click('#pollOptions button[data-value="C"]'); // now wrong
    await sleep(600);
    await host.evaluate(() => Reveal.nextFragment()); // answer
    await sleep(900);
    check(/\+\d+/.test(await a.$eval("#toast", (e) => e.textContent)), "A (right in round 2) scores");
    check(/No points/.test(await b.$eval("#toast", (e) => e.textContent)), "B (right only in round 1) does not");
    check(host.errors.length === 0, "host no errors " + host.errors.join("|"));
  } catch (e) { console.log("FAIL", e); process.exitCode = 1; } finally { await browser.close(); }
})();
