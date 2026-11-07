// Regenerates the marketing images from the real app:
//   public/shots/room.jpg       a room in use, seen by one of the two people
//   public/og.png               1200×630 social card built around that screenshot
//   public/apple-touch-icon.png, icon-192/512.png, icon-maskable-512.png, favicon.ico
//
// It starts a throwaway signaling server and a static build of the UI, then drives two
// Chromium profiles through a real room. Run with `make shots` (needs Go and Chromium).

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const UI = resolve(import.meta.dirname, "..");
const ROOT = resolve(UI, "..");
const WORK = join(UI, ".shots");
const DIST = join(WORK, "dist");
const PUBLIC = join(UI, "public");
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const WS_PORT = 9077;
const WEB_PORT = 4399;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

const log = (s) => console.log(`· ${s}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(PUBLIC, "shots"), { recursive: true });

// ── Throwaway backend and frontend ─────────────────────────────────────────
log("building signaling server");
execFileSync("go", ["build", "-o", join(WORK, "sig"), "."], { cwd: ROOT, stdio: "inherit" });
const sig = spawn(join(WORK, "sig"), [], { env: { ...process.env, LISTEN_ADDR: `127.0.0.1:${WS_PORT}`, STUN_ADDR: "off" }, stdio: "ignore" });

log("building UI against the local server");
execFileSync("bun", ["run", "astro", "build", "--outDir", DIST], {
  cwd: UI,
  env: { ...process.env, PUBLIC_WS_URL: `ws://127.0.0.1:${WS_PORT}/ws` },
  stdio: "ignore",
});

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".xml": "application/xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const web = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, BASE).pathname);
  let file = join(DIST, p);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
}).listen(WEB_PORT, "127.0.0.1");

const cleanup = () => {
  sig.kill();
  web.close();
};
process.on("exit", cleanup);

// ── Two people in a room ───────────────────────────────────────────────────
const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--auto-select-tab-capture-source-by-title=Privacy policy",
    "--auto-accept-this-tab-capture",
  ],
});
const person = async (nick, viewport = { width: 1440, height: 900 }) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true });
  await ctx.addInitScript((n) => localStorage.setItem("tincan:nick", n), nick);
  return ctx;
};
const quiet = (p) => p.addStyleTag({ content: 'div[role="status"].pointer-events-auto{display:none!important}' });

log("staging the room");
const anaCtx = await person("Ana");
const rohanCtx = await person("Rohan");
const ana = await anaCtx.newPage();
const rohan = await rohanCtx.newPage();

await ana.goto(BASE + "/");
await ana.getByRole("button", { name: "Create room" }).waitFor();
await ana.getByPlaceholder("Room name").fill("Design review");
await ana.getByRole("button", { name: "Create room" }).click();
await ana.waitForURL(/\/room\//);
const roomUrl = ana.url();

await rohan.goto(roomUrl);
await rohan.getByRole("button", { name: "Join room" }).click();
await rohan.getByText("Direct link to Ana").first().waitFor({ timeout: 20000 });

// Chat
const say = async (p, text) => {
  await p.getByLabel("Message").fill(text);
  await p.getByLabel("Message").press("Enter");
};
await say(ana, "Sharing the privacy page draft now");
await say(rohan, "Reads well. Can you send me the export too?");
await say(ana, "Sending it over");

// A file, so the receiving side shows a finished shard map
const payload = Buffer.alloc(18 * 1024 * 1024 + 4321);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) >>> 24;
const file = join(WORK, "privacy-review.zip");
writeFileSync(file, payload);
const got = rohan.waitForEvent("download", { timeout: 120000 });
await ana.locator('input[type="file"]').setInputFiles(file);
await got;
await say(rohan, "Got it, thanks");

// A few turns of Quoridor
await ana.getByRole("tab", { name: "Quoridor" }).click();
await ana.getByText("Your turn").waitFor();
const step = async (p, label) => {
  await p.getByRole("button", { name: label }).click();
};
const wall = async (p, r, c, o) => {
  await p.getByRole("radio", { name: "Wall" }).click();
  const b = await p.getByLabel("Quoridor board").boundingBox();
  const u = b.width / (9 + 8 * 0.25);
  const line = (k) => (k * 1.25 + 1.125) * u;
  const x = b.x + line(c) + (o === "h" ? 0.5 * u : 0);
  const y = b.y + line(r) + (o === "v" ? 0.5 * u : 0);
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.up();
};
await step(ana, "Move to row 8, column 5");
await step(rohan, "Move to row 8, column 5");
await step(ana, "Move to row 7, column 5");
await wall(rohan, 2, 0, "h");
await step(ana, "Move to row 6, column 5");
await step(rohan, "Move to row 7, column 5");
await wall(ana, 4, 4, "v");
await rohan.getByText("Your turn").waitFor();

await ana.getByRole("button", { name: /Mic off/ }).click();

// Ana shares a tab with the privacy page draft
const tab = await anaCtx.newPage();
await tab.goto(BASE + "/privacy/");
await ana.bringToFront();
await ana.getByRole("button", { name: /Share screen/ }).click();
await rohan.getByText("Ana's screen").waitFor({ timeout: 20000 });
await rohan.waitForTimeout(4000); // let the stream settle and stats appear

// Chromium's fake capture device sends a test pattern instead of the tab, so paint
// the real tab into the shared-screen view: a screenshot of what Ana is sharing.
await tab.setViewportSize({ width: 1440, height: 810 });
await tab.evaluate(() => window.scrollTo(0, 0));
const shared = (await tab.screenshot({ type: "jpeg", quality: 92 })).toString("base64");
await rohan.evaluate((b64) => {
  const v = [...document.querySelectorAll("video")].find((el) => el.offsetParent && el.classList.contains("object-contain"));
  if (!v) throw new Error("no shared-screen video");
  const img = document.createElement("img");
  img.src = `data:image/jpeg;base64,${b64}`;
  img.className = "absolute inset-0 size-full object-contain";
  v.after(img);
}, shared);
await rohan.waitForTimeout(300);

await quiet(rohan);
await rohan.evaluate(() => window.scrollTo(0, 0));
await rohan.screenshot({ path: join(PUBLIC, "shots/room.jpg"), type: "jpeg", quality: 82 });
log("public/shots/room.jpg");

// ── Social card ────────────────────────────────────────────────────────────
const font = (pkg, file) => `file://${join(UI, "node_modules", pkg, "files", file)}`;
const og = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url(${font("@fontsource-variable/geist", "geist-latin-wght-normal.woff2")}) format("woff2");font-weight:100 900}
@font-face{font-family:GeistMono;src:url(${font("@fontsource-variable/geist-mono", "geist-mono-latin-wght-normal.woff2")}) format("woff2");font-weight:100 900}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#0f0f10;color:#ededed;font-family:Geist;overflow:hidden;position:relative}
.text{position:absolute;left:72px;top:0;bottom:0;width:440px;display:flex;flex-direction:column;justify-content:center}
.brand{display:flex;align-items:center;gap:12px;font-size:28px;font-weight:500}
h1{margin-top:40px;font-size:60px;line-height:1.05;font-weight:500;letter-spacing:-0.02em}
p{margin-top:20px;font-size:24px;line-height:1.4;color:#a1a1a6}
.url{margin-top:40px;font-family:GeistMono;font-size:18px;color:#e8a33d}
.shot{position:absolute;left:560px;top:72px;width:960px;border-radius:18px;overflow:hidden;border:1px solid rgba(237,237,237,.14);box-shadow:0 30px 80px rgba(0,0,0,.6)}
.shot img{display:block;width:100%}
</style></head><body>
<div class="text">
  <div class="brand"><svg width="34" height="34" viewBox="0 0 20 20" fill="none"><rect x="1.75" y="5.75" width="5" height="8.5" rx="1.5" stroke="#ededed" stroke-width="1.5"/><rect x="13.25" y="5.75" width="5" height="8.5" rx="1.5" fill="#e8a33d" stroke="#e8a33d" stroke-width="1.5"/><path d="M6.75 10c2 2.6 4.5 2.6 6.5 0" stroke="#ededed" stroke-width="1.5" stroke-linecap="round"/></svg>Tincan</div>
  <h1>A direct line for two</h1>
  <p>Video calls, screen sharing, chat, files and games. Browser to browser, nothing in between</p>
  <div class="url">tincan.devh.in</div>
</div>
<div class="shot"><img src="file://${join(PUBLIC, "shots/room.jpg")}"></div>
</body></html>`;
writeFileSync(join(WORK, "og.html"), og);
const card = await (await browser.newContext({ viewport: { width: 1200, height: 630 } })).newPage();
await card.goto(`file://${join(WORK, "og.html")}`);
await card.evaluate(() => document.fonts.ready);
await card.screenshot({ path: join(PUBLIC, "og.png") });
log("public/og.png");

// ── Icons ──────────────────────────────────────────────────────────────────
const MARK = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${20 + 2 * pad} ${20 + 2 * pad}" fill="none">
<rect x="${-pad}" y="${-pad}" width="${20 + 2 * pad}" height="${20 + 2 * pad}" fill="#141415"/>
<rect x="2.5" y="6" width="4.5" height="8" rx="1.25" stroke="#ededed" stroke-width="1.4"/>
<rect x="13" y="6" width="4.5" height="8" rx="1.25" fill="#e8a33d" stroke="#e8a33d" stroke-width="1.4"/>
<path d="M7 10c2 2.4 4 2.4 6 0" stroke="#ededed" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const icon = await (await browser.newContext()).newPage();
const renderIcon = async (size, pad, out) => {
  await icon.setViewportSize({ width: size, height: size });
  await icon.setContent(`<body style="margin:0">${MARK(pad).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
  await icon.screenshot({ path: out, omitBackground: false });
};
await renderIcon(180, 1, join(PUBLIC, "apple-touch-icon.png"));
await renderIcon(192, 1, join(PUBLIC, "icon-192.png"));
await renderIcon(512, 1, join(PUBLIC, "icon-512.png"));
await renderIcon(512, 4, join(PUBLIC, "icon-maskable-512.png"));
await renderIcon(16, 0, join(WORK, "16.png"));
await renderIcon(32, 0, join(WORK, "32.png"));
await renderIcon(48, 0, join(WORK, "48.png"));
execFileSync("magick", [join(WORK, "16.png"), join(WORK, "32.png"), join(WORK, "48.png"), join(PUBLIC, "favicon.ico")]);
log("icons");

await browser.close();
cleanup();
rmSync(WORK, { recursive: true, force: true });
process.exit(0);
