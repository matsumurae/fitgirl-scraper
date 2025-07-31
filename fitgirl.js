require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");

// Add stealth plugin to Puppeteer
puppeteer.use(StealthPlugin());

// Configurable
const file = process.env.FILE;
const baseUrl = process.env.BASE_URL;
const fullUrl = `${baseUrl}all-my-repacks-a-z`;
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
let cache = JSON.parse(fs.readFileSync("cache.json", "utf8"));
let cachedNumPages = cache.pages;
let timeout = parseInt(process.env.TIMEOUT);

// Internal counter
let id = 1;

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

// Fetch details for a given game
async function details(game, browser) {
    if (game.verified) return [game, false];
    const page = await browser.newPage();
    try {
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await page.goto(game.link, {
            waitUntil: "networkidle2",
            timeout: timeout,
        });

        // More flexible date selector
        const date = await page.evaluate(() => {
            const dateEl = document.querySelector("time.entry-date");
            if (dateEl && dateEl.getAttribute("datetime")) {
                return dateEl.getAttribute("datetime");
            }
            return null;
        });
        if (date) {
            game.date = new Date(date);
        } else {
            log.warn("details: no date found", {
                id: game.id,
                game: game.name,
            });
            game.date = new Date();
        }

        // Flexible content selector
        const contentText = await page.evaluate(() => {
            const content = document.querySelector(
                ".entry-content, .post-content, article, .content"
            );
            return content
                ? content.textContent.replace(/\n+/g, "\n").split("\n")
                : [];
        });
        if (!contentText.length) {
            log.warn("details: no content found", {
                id: game.id,
                game: game.name,
            });
            await page.close();
            return [game, false];
        }

        // Process content lines
        for (const line of contentText) {
            if (line.match(/genres|tags/i))
                game.tags = line
                    .replace(/.*genres|tags.*?:/i, "")
                    .trim()
                    .split(", ")
                    .filter(Boolean);
            if (line.match(/compan(y|ies)/i))
                game.creator = line
                    .replace(/.*compan(y|ies).*?:/i, "")
                    .trim()
                    .split(", ")
                    .filter(Boolean);
            if (line.match(/original size/i))
                game.original = line.replace(/.*original size.*?:/i, "").trim();
            if (line.match(/repack size/i))
                game.packed = line
                    .replace(/.*repack size.*?:/i, "")
                    .replace(/\[.*\]/, "")
                    .trim();
        }

        // Parse sizes
        const packed = game.packed
            ? Number(
                  game.packed.replace(",", ".").match(/(\d+(\.\d+)?)/)?.[0] || 0
              )
            : 0;
        const original = game.original
            ? Number(
                  game.original.replace(",", ".").match(/(\d+(\.\d+)?)/)?.[0] ||
                      0
              )
            : 0;
        game.size = Math.max(packed, original);
        if (game?.size > 0 && game.original?.includes("MB")) game.size /= 1024;
        game.verified = game.size > 0;

        // Extract direct download links
        game.direct = await page.evaluate(() => {
            const directLinks = {};
            const ddl = Array.from(document.querySelectorAll("h3")).find((el) =>
                el.textContent.includes("Download Mirrors (Direct Links)")
            );
            if (ddl) {
                const ul =
                    Array.from(ddl.parentElement.children).find(
                        (el) => el.tagName === "UL" && el !== ddl
                    ) || null;
                if (ul) {
                    const items = ul.querySelectorAll("li");
                    for (const item of items) {
                        const text = item.textContent.toLowerCase();
                        let host = null;
                        if (text.includes("datanodes")) {
                            host = "datanodes";
                        } else if (text.includes("fuckingfast")) {
                            host = "fuckingfast";
                        }
                        if (host) {
                            directLinks[host] = directLinks[host] || [];
                            const spoilerContent = item.querySelector(
                                ".su-spoiler-content"
                            );
                            if (spoilerContent) {
                                const spoilerLinks = Array.from(
                                    spoilerContent.querySelectorAll("a")
                                ).map((a) => a.href);
                                directLinks[host].push(...spoilerLinks);
                            }
                        }
                    }
                }
            }
            return directLinks;
        });

        log.data("details", {
            id: game.id,
            verified: game.verified,
            game: game.name,
            link: game.link,
            size: game.size,
            direct: game.direct,
        });

        if (!game.verified && debug) {
            log.debug("content lines", contentText);
            log.debug("sizes", { packed, original });
            log.debug("game", game);
        }

        // Find magnet link
        const magnet = await page.evaluate(() => {
            const href = document.querySelector('a[href*="magnet"]');
            return href ? href.getAttribute("href") : null;
        });
        if (magnet) game.magnet = magnet;

        await page.close();
        return [game, game.verified];
    } catch (err) {
        log.warn("details error", {
            id: game.id,
            game: game.name,
            error: err.message,
        });
        await page.close();
        return [game, false];
    }
}

// Load game database from JSON
async function load() {
    try {
        if (!fs.existsSync(file)) {
            log.warn("load: file does not exist, creating empty file", {
                file,
            });
            fs.writeFileSync(file, JSON.stringify([]));
        }
        const res = fs.readFileSync(file);
        const data = JSON.parse(res);
        const filtered = data.filter((d) => d.id);
        for (const game of filtered) {
            game.date = new Date(game.date);
            game.verified = game.verified === true && game.size > 0;
            game.size = Math.round(10 * game.size) / 10;
        }
        log.data("load", {
            file,
            games: filtered.length,
            verified: filtered.filter((g) => g.verified).length,
        });
        return filtered;
    } catch (err) {
        log.error("load failed", { file, error: err.message });
        return [];
    }
}

// Save game database to JSON
async function save(games) {
    try {
        const json = JSON.stringify(games, null, 2);
        fs.writeFileSync(file, json);
        log.data("save", {
            games: games.length,
            verified: games.filter((g) => g.verified).length,
            withDirect: games.filter(
                (g) => g.direct && Object.keys(g.direct).length > 0
            ).length,
            missingDirect: games.filter((g) => g.verified && !g.direct),
        });
    } catch (err) {
        log.error("save failed", { file, error: err.message });
    }
}

// Update list of games with retries
async function update(games, browser, attempt = 1) {
    const content = await html(fullUrl, browser);
    if (!content) {
        log.error("update failed: no content");
        if (attempt < maxRetries) {
            log.info(`Retrying update (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            return update(games, browser, attempt + 1);
        }
        return games;
    }

    const page = await browser.newPage();
    try {
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await page.goto(fullUrl, {
            waitUntil: "networkidle2",
            timeout: timeout,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelay));

        // Extract number of pages only if not cached
        if (cachedNumPages === null) {
            cachedNumPages = await page.evaluate(() => {
                const pagination = document.querySelector(".lcp_paginator");
                if (!pagination) return 1;
                const links = pagination.querySelectorAll("li");
                if (links.length < 2) return 1;
                const secondLastLink = links[links.length - 2];
                return parseInt(secondLastLink.textContent.trim()) || 1;
            });
            log.data("pages", { total: cachedNumPages });
            cache.pages = cachedNumPages;
            // Save cached page count to a file for future runs
            fs.writeFileSync("cache.json", JSON.stringify(cache, null, 2));
        } else {
            log.debug("using cached page count", { total: cachedNumPages });
        }

        let newGamesCount = 0;
        // Iterate through all pages
        for (let pageNum = 1; pageNum <= cachedNumPages; pageNum++) {
            const pageUrl = `${fullUrl}/?lcp_page0=${pageNum}#lcp_instance_0`;
            await page.goto(pageUrl, {
                waitUntil: "networkidle2",
                timeout: timeout,
            });
            await new Promise((resolve) => setTimeout(resolve, retryDelay));

            // Extract games
            const gamesElements = await page.evaluate(() => {
                const list = document.querySelector("#lcp_instance_0");
                if (!list) return [];
                const items = list.querySelectorAll("li a");
                return Array.from(items)
                    .map((a) => ({
                        name: a.textContent.trim(),
                        link: a.href,
                    }))
                    .filter((item) => item.name && item.link);
            });

            log.data("scraped games", {
                page: pageNum,
                games: gamesElements.map((g) => g.name),
            });

            // Check for new games by comparing links
            for (const { name, link } of gamesElements) {
                if (!games.find((game) => game.link === link)) {
                    let newGame = {
                        id: id++, // Ensure `id` is defined elsewhere
                        name,
                        link,
                        date: new Date(),
                        tags: [],
                        creator: [],
                        original: "",
                        packed: "",
                        size: 0,
                        verified: false,
                        magnet: null,
                        direct: {},
                    };
                    log.info("new game found", { name, link });

                    // Fetch full details for the new game
                    const [updatedGame, verified] = await details(
                        newGame,
                        browser
                    );
                    // Ensure the updated game has all required fields
                    newGame = {
                        id: updatedGame.id,
                        name: updatedGame.name,
                        link: updatedGame.link,
                        date: updatedGame.date || new Date(),
                        tags: updatedGame.tags || [],
                        creator: updatedGame.creator || [],
                        original: updatedGame.original || "",
                        packed: updatedGame.packed || "",
                        size: updatedGame.size || 0,
                        verified: updatedGame.verified || false,
                        magnet: updatedGame.magnet || null,
                        direct: updatedGame.direct || {},
                    };
                    // Only save if the game has valid data
                    if (
                        newGame.verified ||
                        newGame.size > 0 ||
                        newGame.magnet ||
                        Object.keys(newGame.direct).length > 0
                    ) {
                        games.push(newGame);
                        await save(games); // Save to JSON immediately
                        newGamesCount++;
                        log.info("new game details saved", {
                            name,
                            link,
                            verified: newGame.verified,
                            size: newGame.size,
                            date: newGame.date.toISOString(),
                            tags: newGame.tags,
                            creator: newGame.creator,
                            magnet: newGame.magnet ? "present" : "absent",
                            direct:
                                Object.keys(newGame.direct).length > 0
                                    ? "present"
                                    : "absent",
                        });
                    } else {
                        log.warn("skipping save: incomplete game data", {
                            name,
                            link,
                            verified: newGame.verified,
                            size: newGame.size,
                        });
                    }
                } else {
                    log.debug("game already exists", { name, link });
                }
            }
        }

        log.data("update summary", {
            pages: cachedNumPages,
            existing: games.length - newGamesCount,
            new: newGamesCount,
            total: games.length,
            todo: games.filter((g) => !g.verified).length,
        });

        await page.close();
        return games;
    } catch (err) {
        log.error("update failed", { attempt, error: err.message });
        await page.close();
        if (attempt < maxRetries) {
            log.info(`Retrying update (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            return update(games, browser, attempt + 1);
        }
        return games;
    }
}

// Main function
async function main() {
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
        const games = await load();
        const updated = await update(games, browser);
        if (games.length !== updated.length) await save(updated);
        for (let i = 0; i < updated.length; i++) {
            const [game, update] = await details(updated[i], browser);
            updated[i] = game;
            if (update) await save(updated);
        }
        await save(updated);
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    main();
} else {
    exports.load = load;
    exports.save = save;
    exports.update = update;
    exports.details = details;
}
