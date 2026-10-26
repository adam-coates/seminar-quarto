const { sleep, launch, openHost, openPhone, gotoSlide, check } = require("./lib");
const hasAnswer = (p) => p.evaluate(() => !!document.getElementById("answerBox"));
(async () => {
  const browser = await launch();
  try {
    // embedded (demo deck): step to the answer, step back
    const host = await openHost(browser, "index.html");
    const p = await openPhone(browser, "index.html");
    await p.waitForSelector("#nickSkip"); await p.click("#nickSkip");
    await gotoSlide(host, "What is the capital of Australia?");
    await p.waitForSelector('#pollOptions button[data-value="B"]');
    await p.click('#pollOptions button[data-value="B"]');
    await sleep(400);
    await host.evaluate(() => Reveal.next()); // too far: the answer
    await sleep(700);
    check(await hasAnswer(p), "phone shows the answer after the reveal");
    await host.evaluate(() => Reveal.prev()); // back
    await sleep(700);
    check(!(await hasAnswer(p)), "phone drops the answer when the presenter steps back");
    check(await p.$eval('#pollOptions button[data-value="B"]', (b) => b.classList.contains("selected") && !b.classList.contains("is-correct")), "phone shows its vote again, unmarked");
    check(!(await host.$eval('.lp-row[data-value="B"]', (r) => r.classList.contains("lp-correct"))), "slide row is not green");
    // a late joiner is not told it either
    const late = await openPhone(browser, "index.html");
    await late.waitForSelector("#nickSkip"); await late.click("#nickSkip");
    await late.waitForSelector("#pollOptions");
    await sleep(800);
    check(!(await hasAnswer(late)), "late joiner gets no answer");
    // and revealing again still works
    await host.evaluate(() => Reveal.next());
    await sleep(700);
    check(await hasAnswer(p), "revealing again shows it again");

    // classic: answer on the results slide, then back to the voting slide
    await gotoSlide(host, "The classic layout");
    await p.waitForSelector('#pollOptions button[data-value="A"]');
    await p.click('#pollOptions button[data-value="A"]');
    await gotoSlide(host, "Classic results");
    await host.evaluate(() => Reveal.next());
    await sleep(700);
    // the phone is still on the classic poll, which is the active one
    check(await hasAnswer(p), "classic: phone shows the answer");
    await host.evaluate(() => Reveal.left()); // back a whole slide
    await sleep(900);
    check(!(await hasAnswer(p)), "classic: going back a slide takes the answer off the phone");
    check([].concat(host.errors, p.errors, late.errors).length === 0, "no errors " + [].concat(host.errors, p.errors, late.errors).join("|"));
  } catch (e) { console.log("FAIL", e); process.exitCode = 1; } finally { await browser.close(); }
})();
