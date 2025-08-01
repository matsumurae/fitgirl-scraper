// This search games inside the JSON file
// It can be used to find a specific game or to show the newest/largest games
// Usage: node run find <search-term>
require("dotenv").config();

const fs = require("fs");
const process = require("process");
const log = require("@vladmandic/pilogger");

const maxResults = 40;
const file = process.env.FILE;

async function load() {
    try {
        const data = JSON.parse(fs.readFileSync(file));
        const filtered = data.filter((d) => d.id);
        log.data(`Loading ${file}. There's ${filtered.length}.`);
        return filtered;
    } catch (error) {
        log.error(`⚠️ Failed to load ${file}. Error: ${err.message}`);
        return [];
    }
}

async function main() {
    log.configure({ inspect: { breakLength: 500 } });
    log.headerJson();

    const games = (await load()).map(({ name, size, date, tags, link }) => ({
        name,
        size,
        date,
        tags: tags?.join(" ") || "",
        link,
    }));

    const searchTerm = process.argv[2]?.toLowerCase();
    if (searchTerm) {
        const found = games
            .filter(
                (game) =>
                    game.name?.toLowerCase().includes(searchTerm) ||
                    game.tags?.toLowerCase().includes(searchTerm)
            )
            .sort((a, b) => b.date - a.date)
            .slice(0, maxResults);
        log.data({ search: searchTerm, results: found });
    } else {
        const newest = games
            .sort((a, b) => b.date - a.date)
            .slice(0, maxResults);
        const largest = games
            .sort((a, b) => b.size - a.size)
            .slice(0, maxResults);
        log.data({ newest, largest });
    }
}

main().catch((error) => log.error("Main error:", error.message));
