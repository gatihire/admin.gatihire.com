# SWR Caching Architecture for Admin Portal

## Problem Statement

The Admin Portal previously experienced performance bottlenecks and increased database load due to its data fetching strategy. When navigating between different dashboard tabs (e.g., Jobs, Clients, Candidates), the application would often perform a hard refresh, bypassing any client-side cache and directly querying the database (Supabase) for all data. This resulted in:

1.  **Slow UI Responsiveness:** Users experienced noticeable delays (2-5 seconds) when switching tabs, as the UI had to wait for fresh data to be fetched from the backend.
2.  **Increased Database Load:** Frequent, un-cached requests put unnecessary pressure on the Supabase database, especially during peak usage, potentially leading to higher operational costs and reduced database performance.
3.  **Suboptimal User Experience:** The constant waiting for data to load created a less fluid and efficient user experience.

## Solution: Stale-While-Revalidate (SWR) Caching

To address these issues, the data fetching architecture has been upgraded to utilize the **Stale-While-Revalidate (SWR)** caching pattern. This pattern prioritizes immediate UI responsiveness while ensuring data freshness in the background.

The core idea behind SWR is:

1.  **Stale Data First:** Immediately display the data that is already available in the cache (even if it's "stale").
2.  **Revalidate in Background:** Asynchronously fetch the latest data from the server.
3.  **Update UI:** Once the fresh data arrives, update the UI seamlessly.

This approach provides an "instant-on" experience for the user, as they don't have to wait for the network request to complete before seeing content. The UI is then updated with the most current information as soon as it's available.

### Implementation Details

The SWR logic is integrated into the existing `getSessionCached` and `cachedFetchJson` utility functions located in `lib/utils.ts`.

-   **`getSessionCached<T>(key: string, loader: () => Promise<T>, opts?: { ttlMs?: number; force?: boolean; swr?: boolean; onData?: (data: T) => void })`**: This function now accepts new options:
    -   `swr: boolean`: When `true`, enables the SWR behavior.
    -   `onData: (data: T) => void`: An optional callback function that is executed immediately with the cached data (if available) and then again with the fresh data once it's fetched from the server. This allows for progressive UI updates.

-   **`cachedFetchJson<T>(key: string, input: RequestInfo | URL, init?: RequestInit, opts?: { ttlMs?: number; force?: boolean; swr?: boolean; onData?: (data: T) => void })`**: This function wraps `getSessionCached` for API calls, providing the same SWR capabilities.

When `swr: true` is passed, the system will:
1.  Check `sessionStorage` for cached data. If found and not forced to refresh, it will return the cached data immediately.
2.  If `onData` is provided, it will call `onData` with the cached data.
3.  It will then proceed to fetch fresh data from the `loader` (or API endpoint).
4.  Once the fresh data is received, it updates the `sessionStorage` and calls `onData` again with the new data.

This ensures that the UI is never blocked waiting for network requests on subsequent loads, and data is eventually consistent.

## Updated Dashboards

The following dashboards and components have been updated to leverage the new SWR caching architecture:

-   **Jobs Dashboard**: `components/jobs-dashboard.tsx`
-   **Candidates Dashboard**: `contexts/candidate-context.tsx`
-   **Clients Dashboard**: `components/clients-dashboard.tsx`
-   **Credit Requests Dashboard**: `components/credit-requests-dashboard.tsx`
-   **Analytics Dashboard**: `components/analytics-dashboard.tsx`
-   **Super Admin Dashboard**: `components/super-admin-dashboard.tsx`

## Usage Example

To utilize the SWR pattern in a component:

```typescript
import { cachedFetchJson } from "@/lib/utils";

// ... inside a React component or hook

const [data, setData] = useState<MyDataType | null>(null);
const [loading, setLoading] = useState(true);

useEffect(() => {
  const fetchData = async () => {
    setLoading(true);
    try {
      await cachedFetchJson<MyDataType>(
        "my-unique-cache-key",
        "/api/my-endpoint",
        undefined,
        {
          ttlMs: 5 * 60 * 1000, // Cache for 5 minutes
          swr: true, // Enable SWR
          onData: (freshData) => {
            // This callback is called immediately with cached data,
            // and again with fresh data from the network.
            setData(freshData);
          },
        }
      );
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setLoading(false);
    }
  };

  fetchData();
}, []);
```

By implementing SWR, the Admin Portal now offers a significantly faster and more responsive user experience, while simultaneously reducing the load on the backend infrastructure.