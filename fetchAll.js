require("dotenv").config();
const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");
const yargs = require("yargs");

// Add stealth plugin to Puppeteer
puppeteer.use(StealthPlugin());

// Command-line arguments
const argv = yargs.option("start-index", {
    type: "number",
    default: 1,
    description: "Starting page index",
}).argv;

// Configurable
const baseUrl = process.env.BASE_URL;
const fullUrl = `${baseUrl}all-my-repacks-a-z`;
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);
const cacheFile = "cache.json";
let cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));

// Fetch HTML content of a URI using Puppeteer with retries
async function html(uri, browser, attempt = 1) {
    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await page.goto(uri, { waitUntil: "networkidle2", timeout: timeout });
        const html = await page.content();
        await page.close();
        return html;
    } catch (err) {
        if (err.message.includes("net::ERR_CONNECTION_REFUSED")) {
            log.error("Connection refused by server", { uri, attempt });
            if (attempt < maxRetries) {
                log.info(
                    `Retrying ${uri} (attempt ${attempt + 1}/${maxRetries})`
                );
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
                return html(uri, browser, attempt + 1);
            }
            log.error("All retries failed for", { uri });
            return "";
        }
        log.warn("fetch error", { uri, attempt, error: err.message });
        if (attempt < maxRetries) {
            log.info(`Retrying ${uri} (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            return html(uri, browser, attempt + 1);
        }
        log.error("fetch failed after retries", { uri, error: err.message });
        return "";
    }
}

// Update cache with new page count
async function updateCachePageCount(browser) {
    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await page.goto(fullUrl, {
            waitUntil: "networkidle2",
            timeout: timeout,
        });

        const lastPageNum = await page.evaluate(() => {
            const paginator = document.querySelector(".lcp_paginator");
            if (!paginator) return null;
            const links = paginator.querySelectorAll("a");
            if (links.length < 2) return 1;
            // Get penultimate link (last number before "Next page")
            const penultimateLink = links[links.length - 2];
            return parseInt(penultimateLink.getAttribute("title")) || 1;
        });

        if (lastPageNum && lastPageNum !== cache.pages) {
            cache.pages = lastPageNum;
            cache.lastChecked = new Date().toISOString();
            fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
            log.info("Updated cache", {
                pages: lastPageNum,
                lastChecked: cache.lastChecked,
            });
        } else if (!lastPageNum) {
            log.warn("Could not determine page count");
        }

        await page.close();
        return lastPageNum || cache.pages;
    } catch (err) {
        log.error("Failed to update cache page count", { error: err.message });
        return cache.pages;
    }
}

// Save a single game to complete.json
async function saveGame(game, fileName) {
    try {
        let games = [];
        if (fs.existsSync(fileName)) {
            const data = fs.readFileSync(fileName, "utf8");
            games = JSON.parse(data);
        }

        // Check for duplicates using the 'link' property
        if (!games.find((g) => g.link === game.link)) {
            games.push(game);
            fs.writeFileSync(fileName, JSON.stringify(games, null, 2));
            log.info("Saved game to JSON", {
                id: game.id,
                name: game.name,
                link: game.link,
                savedTo: fileName,
            });
        } else {
            log.debug("Game already exists in JSON", {
                name: game.name,
                link: game.link,
            });
        }
    } catch (err) {
        log.error("Save game failed", {
            file: fileName,
            error: err.message,
        });
    }
}

// Save current page number to state.json
async function saveState(pageNum) {
    try {
        const state = { currentPage: pageNum };
        fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
        log.debug("Saved state", { currentPage: pageNum });
    } catch (err) {
        log.error("Save state failed", { error: err.message });
    }
}

// Load current page number from state.json
function loadState() {
    try {
        if (fs.existsSync("state.json")) {
            const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
            return state.currentPage || argv.startIndex;
        }
        return argv.startIndex;
    } catch (err) {
        log.error("Load state failed, using start-index", {
            error: err.message,
            startIndex: argv.startIndex,
        });
        return argv.startIndex;
    }
}

// Main scraping function
async function scrape() {
    log.configure({ inspect: { breakLength: 500 } });
    log.headerJson();

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--ignore-certificate-errors",
        ],
    });

    try {
        // Update cache page count
        const cachedNumPages = await updateCachePageCount(browser);

        let startPage = loadState();
        let id = 1;
        let games = [];
        if (fs.existsSync("complete.json")) {
            games = JSON.parse(fs.readFileSync("complete.json", "utf8"));
            id = games.length > 0 ? Math.max(...games.map((g) => g.id)) + 1 : 1;
        }

        // Iterate through all pages starting from startPage
        for (let pageNum = startPage; pageNum <= cachedNumPages; pageNum++) {
            const pageUrl = `${fullUrl}/?lcp_page0=${pageNum}#lcp_instance_0`;
            const content = await html(pageUrl, browser);
            if (!content) {
                log.error("No content fetched for page", { pageNum });
                continue;
            }

            const page = await browser.newPage();
            try {
                await page.setUserAgent(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
                );
                await page.goto(pageUrl, {
                    waitUntil: "networkidle2",
                    timeout: timeout,
                });
                await new Promise((resolve) => setTimeout(resolve, retryDelay));

                // Extract games
                const gamesElements = await page.evaluate(() => {
                    const list = document.querySelector("ul.lcp_catlist");
                    if (!list) return [];
                    const items = list.querySelectorAll("li a");
                    return Array.from(items)
                        .map((a) => ({
                            name: a.textContent.trim(),
                            link: a.href,
                        }))
                        .filter((item) => item.name && item.link);
                });

                log.data("Scraped page", {
                    page: pageNum,
                    games: gamesElements.length,
                });

                // Process each game individually
                for (const { name, link } of gamesElements) {
                    const game = {
                        id: id++,
                        name,
                        link,
                        page: pageNum,
                    };
                    log.info("Found game", {
                        id: game.id,
                        name: game.name,
                        link: game.link,
                    });
                    await saveGame(game, "complete.json");
                }

                await saveState(pageNum + 1);
                await page.close();
            } catch (err) {
                log.error("Page processing failed", {
                    pageNum,
                    error: err.message,
                });
                await page.close();
            }
        }

        log.data("Scraping completed", { totalPages: cachedNumPages });
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    scrape();
}
