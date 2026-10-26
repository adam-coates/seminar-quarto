// Shared helpers for driving the deck (presenter) and poll.html (phones).
// tests/run.sh sets the environment; see tests/README.md.
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
// screenshots and exported files land here (CI keeps them when a run fails)
const OUT = (process.env.OUT_DIR || path.join(os.tmpdir(), "livepoll-tests")) + "/";
fs.mkdirSync(OUT + "shots", { recursive: true });

const BASE = process.env.BASE || "http://localhost:8081/";
// Every request to anything other than localhost, from any page in the run:
// livepoll must not load anything from a CDN. Quarto's own MathJax is the one
// known exception (see the README's note on html-math-method).
const EXTERNAL = new Set();
process.on("exit", () => {
  if (EXTERNAL.size) { console.log("FAIL: external requests:", [...new Set([...EXTERNAL].map((u) => u.replace(/^(\w+:\/\/[^/]+\/[^/]+\/[^/@]+).*/, "$1")))]); process.exitCode = 1; }
  else console.log("ok: no external requests");
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--window-size=1400,900"],
  });
}

// Each phone gets its own incognito context, so its own localStorage.
async function newPage(browser, { isolated = true, viewport, deck = "index.html" } = {}) {
  const ctx = isolated ? await browser.createBrowserContext() : browser.defaultBrowserContext();
  const page = await ctx.newPage();
  if (viewport) await page.setViewport(viewport);
  page.errors = [];
  page.dialogs = [];
  page.on("dialog", (d) => { page.dialogs.push(d.message()); d.dismiss(); });
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("request", (r) => {
    const u = r.url();
    if (!/^(https?|wss?):\/\/(localhost|127\.0\.0\.1)[:/]/.test(u) && !/^(data|blob|about):/.test(u) && !/^https:\/\/cdn\.jsdelivr\.net\/npm\/mathjax@/.test(u)) EXTERNAL.add(u);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 404/.test(m.text())) page.errors.push("console: " + m.text());
  });
  return page;
}

async function openHost(browser, deck = process.env.DECK || "test.html", hashSlide = "") {
  const page = await newPage(browser, { viewport: { width: 1400, height: 900 } });
  await page.goto(BASE + deck + hashSlide, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.Reveal && Reveal.isReady && Reveal.isReady());
  await page.waitForFunction(() => document.getElementById("password"));
  // log in as host
  await page.evaluate(() => {
    document.getElementById("password").value = "test";
    RevealSeminar.open_or_join_room("test", "Lecturer");
  });
  await page.waitForFunction(() => RevealSeminar.hosting(), { timeout: 10000 });
  return page;
}

async function openPhone(browser, deck = process.env.DECK || "test.html") {
  const page = await newPage(browser, { viewport: { width: 390, height: 844 } });
  await page.goto(BASE + "poll.html?deck=" + deck, { waitUntil: "networkidle0" });
  await page.waitForFunction(
    () => /Connected|Waiting for poll|Cast your vote|vote again|Send a word|Rate each|Pick one|submit|answer|guess|Tap|closed/i.test(document.getElementById("status").textContent),
    { timeout: 15000 }
  );
  return page;
}

async function gotoSlide(page, title) {
  await page.evaluate((title) => {
    const sections = Array.from(document.querySelectorAll(".slides > section"));
    const i = sections.findIndex((s) => (s.querySelector("h2") || {}).textContent === title);
    if (i < 0) throw new Error("no slide " + title);
    Reveal.slide(i);
  }, title);
  await sleep(700);
}

function check(cond, msg) {
  if (!cond) {
    console.log("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
}

module.exports = { OUT, BASE, sleep, launch, newPage, openHost, openPhone, gotoSlide, check };
