#!/usr/bin/env node
/**
 * QA Scan — disk-based Playwright check for a running dev server or deployed site.
 *
 * Replaces the interactive Playwright-MCP navigate -> snapshot -> navigate loop for
 * routine frontend verification: one process launch, one compact text report,
 * screenshots written to disk for visual review (Read the PNG instead of an MCP
 * screenshot round-trip).
 *
 * Usage:
 *   node scan.mjs <base-url> [options]
 *
 * Options:
 *   --routes /,/about,/contact        Routes to check (default: /)
 *   --viewports mobile:375x812,desktop:1280x800   (default shown)
 *   --out <dir>                       Screenshot output dir (default: ./qa-out)
 *   --locale <locale>                 Browser locale (default: en-US)
 *   --no-links                        Skip same-origin link check
 *   --no-screenshots                  Skip screenshot capture (console/link checks only)
 *
 * Exit codes: 0 = clean, 1 = issues found, 2 = usage/runtime error
 *
 * Examples:
 *   node scan.mjs http://localhost:5173
 *   node scan.mjs http://localhost:5173 --routes /,/about,/contact --locale he-IL
 *   node scan.mjs https://my-demo.vercel.app --viewports mobile:375x812
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_VIEWPORTS = "mobile:375x812,desktop:1280x800";
const NAV_TIMEOUT = 15_000;
const LINK_TIMEOUT = 8_000;

function parseArgs(argv) {
  const baseUrl = argv[0];
  const opts = {
    routes: ["/"],
    viewports: DEFAULT_VIEWPORTS,
    out: "./qa-out",
    locale: "en-US",
    links: true,
    screenshots: true,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--routes") opts.routes = argv[++i].split(",").map((r) => r.trim());
    else if (a === "--viewports") opts.viewports = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--locale") opts.locale = argv[++i];
    else if (a === "--no-links") opts.links = false;
    else if (a === "--no-screenshots") opts.screenshots = false;
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    }
  }
  return { baseUrl, opts };
}

function parseViewports(spec) {
  return spec.split(",").map((part) => {
    const [name, size] = part.includes(":") ? part.split(":") : [part, part];
    const [width, height] = size.split("x").map(Number);
    if (!width || !height) {
      console.error(`Bad viewport spec: ${part} (want name:WxH, e.g. mobile:375x812)`);
      process.exit(2);
    }
    return { name, width, height };
  });
}

function slug(route) {
  return route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "-") || "home";
}

const { baseUrl, opts } = parseArgs(process.argv.slice(2));
if (!baseUrl) {
  console.error("Usage: node scan.mjs <base-url> [--routes /,/about] [--viewports mobile:375x812,desktop:1280x800] [--out ./qa-out] [--locale en-US] [--no-links] [--no-screenshots]");
  process.exit(2);
}

const viewports = parseViewports(opts.viewports);
const origin = new URL(baseUrl).origin;
if (opts.screenshots) mkdirSync(opts.out, { recursive: true });

const results = []; // { route, viewport, ok, consoleErrors: [], pageErrors: [], navStatus, screenshot }
const discoveredLinks = new Set();
const runtimeErrors = [];

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  console.error(`ERROR: failed to launch browser: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

for (const route of opts.routes) {
  const url = new URL(route, baseUrl).toString();
  let linksExtracted = false;

  for (const vp of viewports) {
    const entry = { route, viewport: vp.name, ok: true, consoleErrors: [], pageErrors: [], navStatus: null, screenshot: null };
    let page;
    try {
      const context = await browser.newContext({ locale: opts.locale, viewport: { width: vp.width, height: vp.height } });
      page = await context.newPage();

      page.on("console", (msg) => {
        if (msg.type() === "error") entry.consoleErrors.push(msg.text().slice(0, 200));
      });
      page.on("pageerror", (err) => {
        entry.pageErrors.push(String(err.message || err).slice(0, 200));
      });

      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
      entry.navStatus = resp ? resp.status() : null;
      await page.waitForTimeout(500);

      if (opts.links && !linksExtracted) {
        const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
        for (const href of hrefs) {
          if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
          try {
            const abs = new URL(href, url);
            if (abs.origin === origin) discoveredLinks.add(abs.toString());
          } catch {
            // not a parseable URL, skip
          }
        }
        linksExtracted = true;
      }

      if (opts.screenshots) {
        const file = join(opts.out, `${slug(route)}-${vp.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        entry.screenshot = file;
      }

      await context.close();
    } catch (err) {
      entry.pageErrors.push(`scan error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (entry.navStatus && entry.navStatus >= 400) entry.ok = false;
    if (entry.consoleErrors.length > 0 || entry.pageErrors.length > 0) entry.ok = false;
    results.push(entry);
  }
}

const brokenLinks = [];
if (opts.links) {
  for (const link of discoveredLinks) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT);
      let res = await fetch(link, { method: "HEAD", signal: controller.signal, redirect: "follow" });
      if (res.status === 405) res = await fetch(link, { method: "GET", signal: controller.signal, redirect: "follow" });
      clearTimeout(timer);
      if (!res.ok) brokenLinks.push({ link, status: res.status });
    } catch (err) {
      brokenLinks.push({ link, status: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

await browser.close();

// ---- Report ----
console.log(`QA SCAN: ${baseUrl}`);
console.log(`Routes: ${opts.routes.join(", ")}  x  Viewports: ${viewports.map((v) => `${v.name}(${v.width}x${v.height})`).join(", ")}\n`);

let issues = 0;
for (const r of results) {
  const status = r.ok ? "OK" : "FAIL";
  if (!r.ok) issues++;
  console.log(`${r.route.padEnd(12)} ${r.viewport.padEnd(9)} ${status}${r.navStatus && r.navStatus >= 400 ? `  nav status ${r.navStatus}` : ""}`);
  for (const c of r.consoleErrors) console.log(`  console  ${c}`);
  for (const p of r.pageErrors) console.log(`  pageerror  ${p}`);
}

if (opts.links) {
  console.log(`\nLinks checked: ${discoveredLinks.size}, broken: ${brokenLinks.length}`);
  for (const b of brokenLinks) {
    console.log(`  FAIL ${b.link} -> ${b.status}`);
    issues++;
  }
}

if (opts.screenshots) {
  const shots = results.filter((r) => r.screenshot).map((r) => r.screenshot);
  console.log(`\nScreenshots: ${opts.out}/ (${shots.length} files)`);
}

console.log(`\nVERDICT: ${issues === 0 ? "CLEAN" : `FAIL — ${issues} issue(s)`}`);
process.exit(issues === 0 ? 0 : 1);
