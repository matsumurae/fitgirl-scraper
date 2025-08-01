// Compare script for FitGirl repacks
// This script compares the current game database with a complete list of games,
// updates the database with new games, and fetches details for each game using Puppeteer.
// It also handles retries for network errors and logs the process.
require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");

// Add stealth plugin to Puppeteer
puppeteer.use(StealthPlugin());

// Configurable
const file = process.env.FILE;
const cacheFile = "cache.json";
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);

// Load cache from cache.json
async function loadCache() {
    try {
        if (!fs.existsSync(cacheFile)) {
            log.warn("loadCache: file does not exist, creating empty file", {
                cacheFile,
            });
            const defaultCache = {
                pages: 0,
                lastChecked: new Date().toISOString(),
                lastId: 0,
            };
            fs.writeFileSync(cacheFile, JSON.stringify(defaultCache, null, 2));
            return defaultCache;
        }
        const res = fs.readFileSync(cacheFile);
        const cache = JSON.parse(res);
        log.data("loadCache", {
            file: cacheFile,
            pages: cache.pages,
            lastId: cache.lastId,
            lastChecked: cache.lastChecked,
        });
        return cache;
    } catch (err) {
        log.error(`⚠️ Failed to load ${cacheFile}. Error: ${err.message}`);
        return { pages: 0, lastChecked: new Date().toISOString(), lastId: 0 };
    }
}

// Save cache to cache.json
async function saveCache(cache) {
    try {
        const json = JSON.stringify(cache, null, 2);
        fs.writeFileSync(cacheFile, json);
        log.data("saveCache", {
            file: cacheFile,
            pages: cache.pages,
            lastId: cache.lastId,
            lastChecked: cache.lastChecked,
        });
    } catch (err) {
        log.error(`⚠️ Failed to load ${cacheFile}. Error: ${err.message}`);
    }
}

// Fetch HTML content of a URI using Puppeteer with retries
async function fetchHtml(uri, browser, attempt = 1) {
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
                return fetchHtml(uri, browser, attempt + 1);
            }
            log.error("All retries failed for", { uri });
            return "";
        }
        log.warn("fetch error", { uri, attempt, error: err.message });
        if (attempt < maxRetries) {
            log.info(`Retrying ${uri} (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            return fetchHtml(uri, browser, attempt + 1);
        }
        log.error("fetch failed after retries", { uri, error: err.message });
        return "";
    }
}

// Fetch details for a given game
async function details(game, browser) {
    try {
        const content = await fetchHtml(game.link, browser);
        if (!content) {
            log.warn("details: no content fetched", {
                id: game.id,
                game: game.name,
            });
            return [game, false];
        }

        const page = await browser.newPage();
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await page.goto(game.link, {
            waitUntil: "networkidle2",
            timeout: timeout,
        });

        // Extract date
        const date = await page.evaluate(() => {
            const dateEl = document.querySelector("time.entry-date");
            return dateEl?.getAttribute("datetime") || null;
        });
        game.date = date ? new Date(date) : new Date();

        // Extract content
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

        // Find magnet link
        const magnet = await page.evaluate(() => {
            const href = document.querySelector('a[href*="magnet"]');
            return href ? href.getAttribute("href") : null;
        });
        if (magnet) game.magnet = magnet;

        // Set verified
        game.verified =
            game.size > 0 && game.magnet && Object.keys(game.direct).length > 0;
        game.lastChecked = new Date().toISOString();

        log.data("details", {
            id: game.id,
            verified: game.verified,
            game: game.name,
            link: game.link,
            size: game.size,
            direct: game.direct,
            lastChecked: game.lastChecked,
        });

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
        const filtered = data.filter((d) => d.link);
        for (const game of filtered) {
            game.date = new Date(game.date);
            game.verified = game.verified === true && game.size > 0;
            game.size = Math.round(10 * game.size) / 10;
            game.lastChecked = game.lastChecked || new Date().toISOString();
        }
        log.data("load", {
            file,
            games: filtered.length,
            verified: filtered.filter((g) => g.verified).length,
        });
        return { games: filtered };
    } catch (err) {
        log.error(`⚠️ Failed to load ${file}. Error: ${err.message}`);
        return { games: [] };
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
            missingDirect: games.filter((g) => g.verified && !g.direct).length,
        });
    } catch (err) {
        log.error(`⚠️ Save ${file} failed. Error: ${err.message}`);
    }
}

// Load complete database from complete.json
async function loadComplete() {
    const completeFile = "complete.json";
    try {
        if (!fs.existsSync(completeFile)) {
            log.warn("⚠️  loadComplete: file does not exist", { completeFile });
            log.warn("💡 Hint: Run 'npm run fetch' to get the data.");
            return [];
        }
        const res = fs.readFileSync(completeFile);
        const data = JSON.parse(res);
        const filtered = data.filter((d) => d.link);
        log.data(
            `✅ complete.json loaded correctly! It has ${
                filtered.length
            } games and ${
                filtered.filter((g) => g.verified).length
            } verified games.`
        );
        return filtered;
    } catch (err) {
        log.error(`⚠️ Failed to load ${completeFile}. Error: ${err.message}`);
        return [];
    }
}

// Update list of games by comparing with complete.json
async function update(games, cache, browser, attempt = 1) {
    const completeGames = await loadComplete();
    let newGamesCount = 0;
    let currentId = cache.lastId;

    // Compare games with complete.json based on link
    for (const completeGame of completeGames) {
        if (!games.find((game) => game.link === completeGame.link)) {
            // Initialize newGame with minimal data from complete.json
            let newGame = {
                id: ++currentId,
                name: completeGame.name,
                link: completeGame.link,
                lastChecked: new Date().toISOString(),
            };
            log.info(`🔎 new game ${newGame.name} found from complete.json`);

            // Scrape details from the game's page
            log.info(`🔎 scraping details for ${newGame.name} game`);
            const [updatedGame, verified] = await details(newGame, browser);
            newGame = {
                id: updatedGame.id,
                name: updatedGame.name,
                link: updatedGame.link,
                date: updatedGame.date,
                tags: updatedGame.tags || [],
                creator: updatedGame.creator || [],
                original: updatedGame.original || "",
                packed: updatedGame.packed || "",
                size: updatedGame.size || 0,
                verified: updatedGame.verified || false,
                magnet: updatedGame.magnet || null,
                direct: updatedGame.direct || {},
                lastChecked:
                    updatedGame.lastChecked || new Date().toISOString(),
            };

            // Only save if the game has valid data
            if (
                newGame.verified ||
                newGame.size > 0 ||
                newGame.magnet ||
                Object.keys(newGame.direct).length > 0
            ) {
                games.push(newGame);
                cache.lastId = currentId; // Update lastId in cache
                await save(games); // Save to games.json
                await saveCache(cache); // Save updated cache
                newGamesCount++;
                log.info(`${newGame.name} game saved.`, {
                    link: newGame.link,
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
                    name: newGame.name,
                    link: newGame.link,
                    verified: newGame.verified,
                    size: newGame.size,
                });
            }
        } else {
            log.debug("game already exists", {
                name: completeGame.name,
                link: completeGame.link,
            });
        }
    }

    log.data("update summary", {
        existing: games.length - newGamesCount,
        new: newGamesCount,
        total: games.length,
        todo: games.filter((g) => !g.verified).length,
    });

    return games;
}

// Count items in compare.json and games.json
async function countItems() {
    try {
        // Load games.json (process.env.FILE)
        const gamesData = await load();
        const gamesCount = gamesData.games.length;

        // Load compare.json
        const completeGames = await loadComplete();
        const completeCount = completeGames.length;

        // Calculate items in compare.json that are not in games.json
        const gamesLinks = new Set(gamesData.games.map((game) => game.link));
        const uniqueToComplete = completeGames.filter(
            (game) => !gamesLinks.has(game.link)
        ).length;

        // Log the counts and difference
        log.data(`🔥 ${gamesCount} on games.json`);
        log.data(`✨ ${completeCount} on complete.json`);
        log.data(`⚠️ ${uniqueToComplete} missing games.`);

        return { gamesCount, completeCount, uniqueToComplete };
    } catch (err) {
        log.error(`⚠️ Count items failed. Error: ${err.message}`);
        return { gamesCount: 0, completeCount: 0, uniqueToComplete: 0 };
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
        const { games } = await load();
        const cache = await loadCache();
        const updated = await update(games, cache, browser);
        if (games.length !== updated.length) await save(updated);
        for (let i = 0; i < updated.length; i++) {
            const [game, update] = await details(updated[i], browser);
            updated[i] = game;
            if (update) await save(updated);
        }
        await save(updated);
        cache.lastChecked = new Date().toISOString();
        await saveCache(cache);
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes("--count-items")) {
        countItems().then(() => process.exit());
    } else {
        main();
    }
} else {
    exports.load = load;
    exports.save = save;
    exports.update = update;
    exports.details = details;
    exports.loadCache = loadCache;
    exports.saveCache = saveCache;
    exports.countItems = countItems;
}
