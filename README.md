# House Accounts v31 – Signal Search Reliability

Purpose: improve business-signal discovery for company lists without order history.

Changes:
- Added optional Brave Search and Tavily search provider support.
- Keeps DuckDuckGo as fallback.
- Passes uploaded City/State, Industry, Notes, and Employees into research context.
- Broadened business-signal search queries with company context.
- Keeps AI qualification layer from v29/v30.

Optional Vercel env vars:
- BRAVE_SEARCH_API_KEY
- TAVILY_API_KEY

At least one real search API is strongly recommended for reliable business signals.
