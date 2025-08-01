# Fitgirl scrapper

This originally came from [fitgirl](https://github.com/vladmandic/fitgirl) but as of today, it doesn't work. That's why I took the project and…

1. Redo it to use puppeteer to imitate a real browser
2. Add DDL links (FuckingFast and DataNodes) to the JSON
3. Update the code to retrieve newest games
4. Keep the number of pages to avoid re-checking every time
5. **Search** now uses the local JSON data instead of scraping again (saving time)

## How to use it

1. Install dependencies with `npm i`
2. Add your `.env` file with

```env
FILE=games.json
BASE_URL=https://fitgirl-repacks.site/
MAX_RETRIES=3
RETRY_DELAY=30000
TIMEOUT=60000
```

Here, you have three options:

-   **Want to check if any saved game had updates?** Use `npm run date` to check if any had updates.
-   **Want to check if there's any new game?** Use `npm run fetch` and follow with `npm run compare`.
-   **Want to find a specific game?** Use `npm run find <name>`.

### `fetchAll.js`

This script scrapes all Fitgirl repacks from A to Z and adds them to a JSON. Then, use the `compare.js` to check which ones aren't on your JSON.

**Be patient! This takes A LOT of time.**

> You can start from a specific point if it stopped. State will be saved each time it goes to next page, but you can use `--check-timestamps --start-index=100` if you want to do it manually.

### Why there's `ddl.js`

It was made to add the DDL links from FuckingFast and Datanodes to the FitGirl repacks database. The original code doesn't allow to add ANY new info if it's a verified game… So I just added empty "direct" and checked all games to add the ones that had those providers.

## Changes

-   I've kept `pilogger` because it looks so cool to see all that colors on console… Pretty easy to check each info.
-   Removed `jquery` and `jsdom` as they didn't serve now… Changed with **puppeteer**.
-   Added `dotenv` to keep static info easily available.
-   Added `lastChecked` on JSON to know when was the last time `fixDate` was run.
