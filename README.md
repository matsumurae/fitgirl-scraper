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
FILE=fitgirl.json
BASE_URL=https://fitgirl-repacks.site/all-my-repacks-a-z
MAX_RETRIES=3
RETRY_DELAY=30000
TIMEOUT=60000
```

3. Run `npm start` to retrieve newest games
4. Run `npm run find <name-here>` to search for a specific game

### Why there's `ddl.js`

It was made to add the DDL links from FuckingFast and Datanodes to the FitGirl repacks database. The original code doesn't allow to add ANY new info if it's a verified game… So I just added empty "direct" and checked all games to add the ones that had those providers.

## Changes

-   I've kept `pilogger` because it looks so cool to see all that colors on console… Pretty easy to check each info.
-   Removed `jquery` and `jsdom` as they didn't serve now… Changed with **puppeteer**.
-   Added `dotenv` to keep static info easily available.
