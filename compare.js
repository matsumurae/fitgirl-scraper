// Compare script for FitGirl repacks
// This script compares the current game database with a complete list of games,
// updates the database with new games, and fetches details for each game using Puppeteer.
require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");
const { saveFile, loadFile, details } = require("./utils");
const { Worker } = require("worker_threads");
const AsyncLock = require("async-lock");

puppeteer.use(StealthPlugin());

const file = process.env.FILE;
const cacheFile = "cache.json";
const tempFile = "temp.json";
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);
const lock = new AsyncLock();

async function loadCache() {
    try {
        if (!fs.existsSync(cacheFile)) {
            log.warn(`${cacheFile} does not exist, creating empty file…`);
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
        log.data(`✅ Saved cache on ${cacheFile}!`);
    } catch (err) {
        log.error(`⚠️ Failed to save ${cacheFile}. Error: ${err.message}`);
    }
}

async function loadComplete() {
    const completeFile = "complete.json";
    try {
        if (!fs.existsSync(completeFile)) {
            log.warn(`⚠️ loadComplete: ${completeFile} does not exist`);
            log.warn("💡 Hint: Run 'npm run fetch' to get the data.");
            return [];
        }
        const res = fs.readFileSync(completeFile);
        const data = JSON.parse(res);
        const filtered = data.filter((d) => d.link);
        log.data(
            `✅ complete.json loaded correctly! It has ${filtered.length} games.`
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
        log.data(`Checked games. Remaining ${games.length} games`);
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

async function checkGames(games) {
    const completeGames = await loadComplete();
    const existingGames = await loadFile(file);
    let newGamesCount = 0;
    let tempGames = await loadTemp();

    const existingLinks = new Set(existingGames.map((game) => game.link));
    const uniqueToComplete = completeGames.filter(
        (game) => !existingLinks.has(game.link)
    ).length;
    log.data(`⚠️ ${uniqueToComplete} missing games.`);

    for (const completeGame of completeGames) {
        if (!existingLinks.has(completeGame.link)) {
            let newGame = {
                id: existingGames.length + 1,
                name: completeGame.name,
                link: completeGame.link,
                lastChecked: new Date().toISOString(),
            };
            log.info(`🔎 New game ${newGame.name} found from complete.json`);
            tempGames.push(newGame);
            newGamesCount++;
        } else {
            log.debug("Game already exists in games.json", {
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
        `${existingGames.length} in games.json. ${newGamesCount} new games added to temp.json, total in temp.json: ${tempGames.length}. You're missing ${uniqueToComplete} games.`
    );

    return { games: existingGames, tempGames };
}

async function processTempGames(games, browser) {
    let tempGames = await loadTemp();
    if (tempGames.length === 0) {
        log.info("No games to process in temp.json");
        await deleteTemp();
        return games;
    }

    log.info(`Processing ${tempGames.length} games from temp.json`);

    const maxWorkers = 4; // Adjust based on system resources
    const activeWorkers = new Set();

    const processGame = (game) => {
        return new Promise((resolve, reject) => {
            const worker = new Worker("./worker.js");
            activeWorkers.add(worker);
            worker.postMessage(game);
            worker.on("message", (msg) => {
                activeWorkers.delete(worker);
                worker.terminate();
                resolve(msg);
            });
            worker.on("error", (err) => {
                activeWorkers.delete(worker);
                worker.terminate();
                reject(err);
            });
        });
    };

    for (const game of tempGames) {
        if (activeWorkers.size >= maxWorkers) {
            await new Promise((resolve) => {
                const checkWorkers = setInterval(() => {
                    if (activeWorkers.size < maxWorkers) {
                        clearInterval(checkWorkers);
                        resolve();
                    }
                }, 100);
            });
        }

        log.info(`🔎 Scraping details for ${game.name}`);
        try {
            const result = await processGame(game);
            if (result.error) {
                log.warn(`Skipping ${game.name} due to error: ${result.error}`);
                continue;
            }

            const newGame = {
                id: result.game.id,
                name: result.game.name,
                link: result.game.link,
                date: result.game.date || new Date().toISOString(),
                tags: result.game.tags || [],
                creator: result.game.creator || [],
                original: result.game.original || "",
                packed: result.game.packed || "",
                size: result.game.size || 0,
                verified: result.verified || false,
                magnet: result.game.magnet || null,
                direct: result.game.direct || {},
                lastChecked:
                    result.game.lastChecked || new Date().toISOString(),
            };

            const shouldSave =
                newGame.verified ||
                newGame.size > 0 ||
                newGame.magnet ||
                Object.keys(newGame.direct).length > 0;

            await lock.acquire("file-save", async () => {
                if (shouldSave) {
                    await saveFile(newGame, file, { isSingleGame: true });
                    games.push(newGame);
                    log.info(`${newGame.name} processed and saved to ${file}`);
                    // Only remove from tempGames if saved successfully
                    tempGames = tempGames.filter(
                        (g) => g.link !== newGame.link
                    );
                    await saveTemp(tempGames);
                    log.info(`Removed ${newGame.name} from temp.json`);
                } else {
                    log.warn("Skipping save: incomplete game data", {
                        name: newGame.name,
                        link: newGame.link,
                        verified: newGame.verified,
                        size: newGame.size,
                        magnet: newGame.magnet ? "present" : "absent",
                        direct:
                            Object.keys(newGame.direct).length > 0
                                ? "present"
                                : "absent",
                    });
                    // Do not remove from tempGames, keep it for retry
                }
            });
        } catch (err) {
            log.error(`Worker error for ${game.name}: ${err.message}`);
            // Keep game in tempGames for retry
        }
    }

    // Wait for all workers to complete
    while (activeWorkers.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (tempGames.length === 0) {
        await deleteTemp();
    }

    // Final save to ensure all games are written to process.env.FILE
    await lock.acquire("file-save", async () => {
        await saveFile(games, file, {
            logMessage: `Final save to ${file} with ${games.length} games`,
        });
        log.info(`Final save completed to ${file} with ${games.length} games`);
    });

    return games;
}

async function countItems() {
    try {
        const games = await loadFile(file);
        const gamesCount = games.length;
        const completeGames = await loadComplete();
        const completeCount = completeGames.length;
        const tempGames = await loadTemp();
        const tempCount = tempGames.length;
        const gamesLinks = new Set(games.map((game) => game.link));
        const uniqueToComplete = completeGames.filter(
            (game) => !gamesLinks.has(game.link)
        ).length;

        log.data(
            `🔥 ${gamesCount} on games.json and ${
                games.filter((g) => g.verified).length
            } verified.`
        );
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
        const games = await loadFile(file);
        log.info(`Loaded ${games.length} games from ${file}`);
        const cache = await loadCache();

        let tempGames = await loadTemp();
        let finalGames;

        if (tempGames.length === 0) {
            log.info("‼️ No temp.json found or empty, running update...");
            const { games: updatedGames, tempGames: updatedTempGames } =
                await checkGames(games);
            log.info(`Update completed. 🔎 Found ${updatedTempGames.length}`);
            finalGames = await processTempGames(updatedGames, browser);
        } else {
            log.info(`🪄 temp.json found with games, processing directly...`);
            finalGames = await processTempGames(games, browser);
        }

        // Ensure final save to process.env.FILE
        await lock.acquire("file-save", async () => {
            await saveFile(finalGames, file, {
                logMessage: `Final save to ${file} with ${finalGames.length} games`,
            });
            log.info(`Final save to ${file} with ${finalGames.length} games`);
        });

        for (let i = 0; i < finalGames.length; i++) {
            const [game, update] = await details(finalGames[i], browser);
            finalGames[i] = game;
            if (update) {
                await lock.acquire("file-save", async () => {
                    await saveFile(finalGames, file, {
                        logMessage: `Updated ${game.name} in ${file}`,
                    });
                    log.info(`Updated ${game.name} in ${file}`);
                });
            }
        }

        // Final save after all updates
        await lock.acquire("file-save", async () => {
            await saveFile(finalGames, file, {
                logMessage: `Final save after updates to ${file}`,
            });
            log.info(`Final save after updates to ${file}`);
        });

        cache.lastChecked = new Date().toISOString();
        await saveCache(cache);
    } catch (err) {
        log.error(`Main failed: ${err.message}`);
        process.exit(1);
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
    exports.loadCache = loadCache;
    exports.saveCache = saveCache;
    exports.countItems = countItems;
    exports.loadTemp = loadTemp;
    exports.saveTemp = saveTemp;
    exports.deleteTemp = deleteTemp;
    exports.processTempGames = processTempGames;
}
