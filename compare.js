// Compare script for FitGirl repacks
// This script compares the current game database with a complete list of games,
// updates the database with new games, and fetches details for each game using Puppeteer.
require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");

puppeteer.use(StealthPlugin());

const file = process.env.FILE;
const cacheFile = "cache.json";
const tempFile = "temp.json";
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);

// Normalize links for comparison to avoid false negatives
function normalizeLink(link) {
    return link
        .toLowerCase()
        .replace(/\/$/, "") // Remove trailing slash
        .replace(/^https?:\/\//, ""); // Remove protocol
}

async function loadCache() {
    try {
        if (!fs.existsSync(cacheFile)) {
            log.warn("loadCache: file does not exist, creating empty file", {
                cacheFile,
            });
            const defaultCache = {
                pages: 0,
                lastChecked: new Date().toISOString(),
            };
            fs.writeFileSync(cacheFile, JSON.stringify(defaultCache, null, 2));
            return defaultCache;
        }
        const res = fs.readFileSync(cacheFile);
        const cache = JSON.parse(res);
        log.data(
            `Cache loaded. ${new Date(
                cache.lastChecked
            ).toLocaleString()} last checked.`
        );
        return cache;
    } catch (err) {
        log.error(`⚠️ Failed to load ${cacheFile}. Error: ${err.message}`);
        return { pages: 0, lastChecked: new Date().toISOString() };
    }
}

async function saveCache(cache) {
    try {
        const json = JSON.stringify(cache, null, 2);
        fs.writeFileSync(cacheFile, json);
        log.data("Saved cache!");
    } catch (err) {
        log.error(`⚠️ Failed to load ${cacheFile}. Error: ${err.message}`);
    }
}

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

        const date = await page.evaluate(() => {
            const dateEl = document.querySelector("time.entry-date");
            return dateEl?.getAttribute("datetime") || null;
        });
        game.date = date ? new Date(date) : new Date();

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

        const magnet = await page.evaluate(() => {
            const href = document.querySelector('a[href*="magnet"]');
            return href ? href.getAttribute("href") : null;
        });
        if (magnet) game.magnet = magnet;

        game.verified =
            game.size > 0 && game.magnet && Object.keys(game.direct).length > 0;
        game.lastChecked = new Date().toISOString();

        log.data(`${game.name} added.`, {
            link: game.link,
            size: game.size,
            direct: game.direct,
            magnet: game.magnet,
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
        log.info(`Loaded ${filtered.length} games from ${file}`, { file });
        for (const game of filtered) {
            game.date = new Date(game.date);
            game.verified = game.verified === true && game.size > 0;
            game.size = Math.round(10 * game.size) / 10;
            game.lastChecked = game.lastChecked || new Date().toISOString();
        }
        log.data(
            `Reading ${file}… It has ${filtered.length} and ${
                filtered.filter((g) => g.verified).length
            } verified.`
        );
        return { games: filtered };
    } catch (err) {
        log.error(`⚠️ Failed to load ${file}. Error: ${err.message}`);
        return { games: [] };
    }
}

async function save(games) {
    try {
        const json = JSON.stringify(games, null, 2);
        fs.writeFileSync(file, json);
        log.data(
            `${games.length} saved! ${
                games.filter((g) => g.verified).length
            } verified.`
        );
    } catch (err) {
        log.error(`⚠️ Save ${file} failed. Error: ${err.message}`);
    }
}

async function loadComplete() {
    const completeFile = "complete.json";
    try {
        if (!fs.existsSync(completeFile)) {
            log.warn("⚠️ loadComplete: file does not exist", { completeFile });
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

async function loadTemp() {
    try {
        if (!fs.existsSync(tempFile)) {
            fs.writeFileSync(tempFile, JSON.stringify([]));
            return [];
        }
        const res = fs.readFileSync(tempFile);
        const data = JSON.parse(res);
        return data;
    } catch (err) {
        log.error(`⚠️ Failed to load ${tempFile}. Error: ${err.message}`);
        return [];
    }
}

async function saveTemp(games) {
    try {
        const json = JSON.stringify(games, null, 2);
        fs.writeFileSync(tempFile, json);
        log.data("saveTemp", { file: tempFile, games: games.length });
        log.data(`Checked games. Saved ${games.length}`);
    } catch (err) {
        log.error(`⚠️ Save ${tempFile} failed. Error: ${err.message}`);
    }
}

async function deleteTemp() {
    try {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
            log.info(`Deleted ${tempFile}`);
        }
    } catch (err) {
        log.error(`⚠️ Failed to delete ${tempFile}. Error: ${err.message}`);
    }
}

async function update(games, cache, browser) {
    const completeGames = await loadComplete();
    let newGamesCount = 0;
    let tempGames = await loadTemp();

    log.debug(
        "Games links:",
        games.map((g) => g.link)
    );
    log.debug(
        "Complete games links:",
        completeGames.map((g) => g.link)
    );

    for (const completeGame of completeGames) {
        if (
            !games.find(
                (game) =>
                    normalizeLink(game.link) ===
                    normalizeLink(completeGame.link)
            )
        ) {
            let newGame = {
                id: games.length + tempGames.length + newGamesCount + 1,
                name: completeGame.name,
                link: completeGame.link,
                lastChecked: new Date().toISOString(),
            };
            log.info(`🔎 new game ${newGame.name} found from complete.json`);
            tempGames.push(newGame);
            newGamesCount++;
        } else {
            log.debug("game already exists", {
                name: completeGame.name,
                link: completeGame.link,
            });
        }
    }

    if (newGamesCount > 0) {
        await saveTemp(tempGames);
        log.info(`Saved ${newGamesCount} new games to ${tempFile}`);
    }

    log.data(
        `${
            games.length
        } updated. ${newGamesCount} are new, that makes a total of ${
            games.length + newGamesCount
        }. You're missing ${tempGames.length}`
    );

    return { games, tempGames };
}

async function processTempGames(games, browser) {
    let tempGames = await loadTemp();
    if (tempGames.length === 0) {
        log.info("No games to process in temp.json");
        await deleteTemp();
        return games;
    }

    log.info(`Processing ${tempGames.length} games from temp.json`);
    for (let i = 0; i < tempGames.length; i++) {
        log.info(`🔎 scraping details for ${tempGames[i].name} game`);
        const [updatedGame, verified] = await details(tempGames[i], browser);
        const newGame = {
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
            lastChecked: updatedGame.lastChecked || new Date().toISOString(),
        };

        if (
            newGame.verified ||
            newGame.size > 0 ||
            newGame.magnet ||
            Object.keys(newGame.direct).length > 0
        ) {
            games.push(newGame);
            await save(games);
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

        tempGames.splice(i, 1);
        i--;
        await saveTemp(tempGames);
    }

    if (tempGames.length === 0) {
        await deleteTemp();
    }

    return games;
}

async function countItems() {
    try {
        const gamesData = await load();
        const gamesCount = gamesData.games.length;
        const completeGames = await loadComplete();
        const completeCount = completeGames.length;
        const tempGames = await loadTemp();
        const tempCount = tempGames.length;
        const gamesLinks = new Set(
            gamesData.games.map((game) => normalizeLink(game.link))
        );
        const uniqueToComplete = completeGames.filter(
            (game) => !gamesLinks.has(normalizeLink(game.link))
        ).length;

        log.data(`🔥 ${gamesCount} on games.json`);
        log.data(`✨ ${completeCount} on complete.json`);
        log.data(`📝 ${tempCount} on temp.json`);
        log.data(`⚠️ ${uniqueToComplete} missing games.`);

        return { gamesCount, completeCount, tempCount, uniqueToComplete };
    } catch (err) {
        log.error(`⚠️ Count items failed. Error: ${err.message}`);
        return {
            gamesCount: 0,
            completeCount: 0,
            tempCount: 0,
            uniqueToComplete: 0,
        };
    }
}

async function main() {
    log.configure({ inspect: { breakLength: 500 } });
    log.headerJson();

    // Validate environment variables
    if (!file || !maxRetries || !retryDelay || !timeout) {
        log.error("Missing required environment variables", {
            FILE: file,
            MAX_RETRIES: maxRetries,
            RETRY_DELAY: retryDelay,
            TIMEOUT: timeout,
        });
        process.exit(1);
    }

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
        log.info(`Loaded ${games.length} games from ${file}`);
        const cache = await loadCache();

        let tempGames = await loadTemp();
        let finalGames;

        if (tempGames.length === 0) {
            log.info("‼️ No temp.json found or empty, running update...");
            const { games: updatedGames, tempGames: updatedTempGames } =
                await update(games, cache, browser);
            log.info(`Update completed. 🔎 Found ${updatedTempGames.length}`);
            finalGames = await processTempGames(updatedGames, browser);
        } else {
            log.info("🪄 temp.json found with games, processing directly...");
            finalGames = await processTempGames(games, browser);
        }

        await save(finalGames);
        for (let i = 0; i < finalGames.length; i++) {
            const [game, update] = await details(finalGames[i], browser);
            finalGames[i] = game;
            if (update) await save(finalGames);
        }
        await save(finalGames);
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
    exports.loadTemp = loadTemp;
    exports.saveTemp = saveTemp;
    exports.deleteTemp = deleteTemp;
    exports.processTempGames = processTempGames;
}
