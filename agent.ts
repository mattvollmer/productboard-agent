import { streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";
import { convertToModelMessages } from "ai";
import * as slackbot from "@blink-sdk/slackbot";

const PB_BASE = "https://api.productboard.com";

let defaultCoderProductId: string | null = null;

type HeadersInit = Record<string, string>;

async function pbHeaders(): Promise<HeadersInit> {
  const token = process.env.PRODUCTBOARD_TOKEN;
  if (!token) throw new Error("Missing PRODUCTBOARD_TOKEN env var");
  return {
    Authorization: `Bearer ${token}`,
    "X-Version": "1",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function pbFetch(input: string | URL, init?: any) {
  const url = typeof input === "string" ? input : input.toString();
  const isAbsolute = url.startsWith("http://") || url.startsWith("https://");
  const finalUrl = isAbsolute ? url : `${PB_BASE}${url}`;
  const res = await fetch(finalUrl, {
    ...init,
    headers: { ...(await pbHeaders()), ...(init?.headers as any) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Productboard ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

async function getDefaultCoderProductId(): Promise<string> {
  if (defaultCoderProductId) return defaultCoderProductId;
  const data = await pbFetch("/products");
  const products = Array.isArray(data?.data) ? data.data : [];
  const coder = products.find(
    (p: any) => (p?.name || "").toLowerCase() === "coder"
  );
  if (!coder)
    throw new Error("Default product 'coder' not found in Productboard");
  const id: string = String(coder.id);
  defaultCoderProductId = id;
  return id;
}

// Add helper sleep function
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Modify pbFetchWithRetry to Retry pbFetch Call
async function pbFetchWithRetry(
  input: string | URL,
  attempts = 3,
  baseDelayMs = 250
) {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await pbFetch(input);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(baseDelayMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

export default blink.agent({
  async sendMessages({ messages }) {
    return streamText({
      // model: "openai/gpt-5-mini",
      model: "anthropic/claude-sonnet-4",
      system: `You are the Productboard data assistant for Coder's GTM and product teams.

Operate strictly via the provided tools to read Productboard data. Do not invent endpoints or parameters.

## Slack-Specific Behavior:
When chatting in Slack channels:

### Interaction Protocol:
- ALWAYS first call slackbot_react_to_message with reaction "thinking_face" to add an :thinking_face: reaction to the latest incoming message before doing anything else
- ALWAYS remove the emoji after you send your response by calling slackbot_react_to_message with reaction "thinking_face" and remove_reaction: true

### Communication Style:
- Keep responses concise and to the point to respect users' time
- Aim for clarity and brevity over comprehensive explanations
- Use bullet points or numbered lists for easy reading when listing items
- Never include emojis in responses unless explicitly asked to do so

### Formatting Guidelines:
- ALWAYS format URLs as clickable links using the <url|text> format
- Don't include markdown headings (#, ##, etc); use *bold text* instead
- Use standard Slack formatting conventions

TEMPORAL AWARENESS:
- ALWAYS call the current_date tool when users mention time-relative terms like "next quarter", "upcoming", "past few weeks", "this month", "Q1", "Q2", etc.
- Use the date context to properly interpret and filter queries about timelines and roadmaps
- When discussing quarters, provide specific date ranges (e.g., "Q1 2025 runs from January 1 to March 31, 2025")
- Help users understand what "current" vs "next" means in concrete date terms

IMPORTANT - USER-FRIENDLY RESPONSES:
- Never show raw UUID strings (e.g., "a1b2c3d4-e5f6-...") in your responses to users
- When tools return only IDs, use additional tool calls to fetch readable names and details
- Present features, releases, objectives, and other items with their human-readable names, not IDs
- Example: Instead of "Feature a1b2c3d4-e5f6-..." say "Feature: Advanced Authentication"
- If you must reference an ID for technical reasons, format it clearly: "Feature: Advanced Authentication (ID: a1b2c3d4-e5f6-...)"

Defaults and scope
- Default product is the one named "coder" when no productId is provided.
- Access to features, releases, statuses, and companies data from Productboard.
- Time horizon of interest is the next 1–2 quarters, but do not filter by time unless explicitly asked.
- Privacy: surfacing customer names and quotes is allowed.
- Prioritize customer-facing language; avoid internal jargon or code.
- Emphasize what matters most to product managers and GTM teams: feature names, statuses, release targets, business impact, and customer insights.

How to answer common questions
- "What are we currently working on?":
  1) List feature statuses and identify in-progress ones.
  2) List features and filter client-side by the in-progress status IDs and the coder product.
- "What's coming next?": use releases if available, otherwise return features by status; ask for clarification if needed.
- Time-based queries ("next quarter", "upcoming", "past few weeks"):
  1) Call current_date tool first to establish temporal context
  2) Provide specific date ranges when discussing quarters or timeframes
  3) Filter results by relevant status IDs and release dates when available

Tooling rules
- Use pagination when links.next is present by accepting/propagating cursor.
- For features: call GET /features without unsupported query params and filter client-side (product, statusIds, limit).
- For notes: use pb_list_notes_summary to browse/filter notes (supports server-side companyId filtering), then pb_get_note_details for specific notes you need full content from.
- On errors, return the HTTP code and a concise explanation of what to try next.

Output format
- Be concise and actionable. Provide small, structured lists with: title, status, release (if any).
- Do not expose chain-of-thought; summarize actions taken only when helpful.
- No notifications or scheduling yet; read-only operations only.
`,
      messages: convertToModelMessages(messages),
      tools: {
        ...slackbot.tools({ messages }),
        // Date/Time awareness
        current_date: tool({
          description:
            "Get the current date and time information. Use this to understand temporal context for queries about 'next quarter', 'past few weeks', 'upcoming', etc.",
          inputSchema: z.object({}),
          execute: async () => {
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentMonth = now.getMonth() + 1; // 0-indexed, so add 1
            const currentQuarter = Math.ceil(currentMonth / 3);

            // Calculate quarter boundaries
            const quarterStartMonth = (currentQuarter - 1) * 3 + 1;
            const quarterEndMonth = currentQuarter * 3;
            const quarterStart = new Date(
              currentYear,
              quarterStartMonth - 1,
              1
            );
            const quarterEnd = new Date(currentYear, quarterEndMonth, 0); // Last day of quarter

            // Next quarter
            const nextQuarter = currentQuarter === 4 ? 1 : currentQuarter + 1;
            const nextQuarterYear =
              currentQuarter === 4 ? currentYear + 1 : currentYear;
            const nextQuarterStartMonth = (nextQuarter - 1) * 3 + 1;
            const nextQuarterEndMonth = nextQuarter * 3;
            const nextQuarterStart = new Date(
              nextQuarterYear,
              nextQuarterStartMonth - 1,
              1
            );
            const nextQuarterEnd = new Date(
              nextQuarterYear,
              nextQuarterEndMonth,
              0
            );

            return {
              current_date: now.toISOString().split("T")[0], // YYYY-MM-DD format
              current_datetime: now.toISOString(),
              current_year: currentYear,
              current_month: currentMonth,
              current_quarter: `Q${currentQuarter} ${currentYear}`,
              current_quarter_start: quarterStart.toISOString().split("T")[0],
              current_quarter_end: quarterEnd.toISOString().split("T")[0],
              next_quarter: `Q${nextQuarter} ${nextQuarterYear}`,
              next_quarter_start: nextQuarterStart.toISOString().split("T")[0],
              next_quarter_end: nextQuarterEnd.toISOString().split("T")[0],
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              day_of_week: now.toLocaleDateString("en-US", { weekday: "long" }),
              week_of_year: Math.ceil(
                (now.getTime() - new Date(currentYear, 0, 1).getTime()) /
                  (7 * 24 * 60 * 60 * 1000)
              ),
            };
          },
        }),

        // Productboard: list products
        pb_list_products: tool({
          description: "List all Productboard products in the workspace.",
          inputSchema: z.object({ cursor: z.string().optional() }),
          execute: async ({ cursor }) => {
            // Handle null cursor values and empty strings properly
            const url =
              cursor && cursor.trim().length > 0 ? cursor : "/products";
            return pbFetch(url);
          },
        }),

        // Productboard: list feature statuses
        pb_list_feature_statuses: tool({
          description: "List all feature statuses (workspace taxonomy).",
          inputSchema: z.object({}),
          execute: async () => pbFetch("/feature-statuses"),
        }),

        // Productboard: list companies
        pb_list_companies: tool({
          description:
            "List all companies with optional filtering and pagination. Supports search by name, filtering by notes association, and feature association.",
          inputSchema: z.object({
            pageLimit: z.number().int().min(1).max(100).optional(),
            pageOffset: z.number().int().min(0).optional(),
            term: z
              .string()
              .optional()
              .describe("Search term to filter companies by name"),
            hasNotes: z
              .boolean()
              .optional()
              .describe(
                "Filter companies by whether they have notes (true) or not (false)"
              ),
            featureId: z
              .string()
              .optional()
              .describe(
                "Filter companies associated with a specific feature ID"
              ),
          }),
          execute: async ({
            pageLimit = 100,
            pageOffset = 0,
            term,
            hasNotes,
            featureId,
          }) => {
            const params = new URLSearchParams();
            params.append("pageLimit", pageLimit.toString());
            params.append("pageOffset", pageOffset.toString());

            if (term) params.append("term", term);
            if (hasNotes !== undefined)
              params.append("hasNotes", hasNotes.toString());
            if (featureId) params.append("featureId", featureId);

            const queryString = params.toString();
            const url = queryString
              ? `/companies?${queryString}`
              : "/companies";

            return pbFetch(url);
          },
        }),

        // Productboard: list features (client-side filtering + optional autopagination)
        pb_list_features: tool({
          description:
            "List features with optional filters. Defaults to product 'coder' when productId is omitted. Single status ID uses server-side filtering for better performance, while multiple status IDs use client-side filtering due to API limitations. Returns only essential fields (no descriptions) to minimize context window usage.",
          inputSchema: z.object({
            productId: z.string().optional(),
            statusIds: z.array(z.string()).optional(),
            statusNames: z.array(z.string()).optional(),
            limit: z.number().int().min(1).max(100).optional(), // Reduced from 1000
            cursor: z.string().optional(),
            autoPaginate: z.boolean().optional(),
            maxPages: z.number().int().min(1).max(10).optional(), // Reduced from 100
            fields: z
              .array(
                z.enum([
                  "id",
                  "name",
                  "status",
                  "product",
                  "owner",
                  "createdAt",
                  "updatedAt",
                  "all",
                ])
              )
              .optional(),
          }),
          execute: async ({
            productId,
            statusIds,
            statusNames,
            limit = 20, // Set reasonable default
            cursor,
            autoPaginate = false, // Disabled by default
            maxPages = 3, // Reduced default
            fields = ["id", "name", "status"], // Default to essential fields only
          }) => {
            const finalProductId =
              productId ?? (await getDefaultCoderProductId());

            // If statusNames are provided, resolve to IDs first
            let resolvedStatusIds: string[] | undefined = statusIds;
            if (
              (!resolvedStatusIds || resolvedStatusIds.length === 0) &&
              statusNames &&
              statusNames.length
            ) {
              const statusResp = await pbFetch(`/feature-statuses`);
              const allStatuses: any[] = Array.isArray(statusResp?.data)
                ? statusResp.data
                : [];
              const wanted = new Set(
                statusNames.map((s: string) => s.toLowerCase())
              );
              resolvedStatusIds = allStatuses
                .filter(
                  (st: any) =>
                    st?.name && wanted.has(String(st.name).toLowerCase())
                )
                .map((st: any) => String(st.id));
            }

            const matches: any[] = [];
            let next: string | undefined = cursor;
            let pages = 0;
            let lastResp: any | undefined;
            let hasError = false;

            // Normalize provided cursor: accept full URL, path, or bare token
            const buildUrlFromCursor = (c?: string): string => {
              if (!c) return "/features";
              const isAbs = /^https?:\/\//i.test(c);
              if (isAbs) return c;
              if (c.startsWith("/")) return c;
              return `/features?pageCursor=${encodeURIComponent(c)}`;
            };

            // Build initial URL with server-side filters
            const buildInitialUrl = (): string => {
              const params = new URLSearchParams();

              // Use server-side status.id filtering ONLY for single status ID
              // Multiple status IDs cause API validation errors, so we'll filter client-side instead
              if (resolvedStatusIds && resolvedStatusIds.length === 1) {
                params.append("status.id", resolvedStatusIds[0]);
              }
              // For multiple status IDs, skip server-side filtering and rely on client-side filtering

              const queryString = params.toString();
              return queryString ? `/features?${queryString}` : "/features";
            };

            const applyFilters = async (arr: any[]) => {
              let out = arr;

              // Only apply product filtering client-side (not supported server-side)
              const hasProductField = out.some(
                (f: any) => f && f.product && f.product.id
              );
              if (hasProductField) {
                const targetProductId =
                  productId ??
                  (defaultCoderProductId ||
                    (defaultCoderProductId = await getDefaultCoderProductId()));
                if (targetProductId) {
                  out = out.filter(
                    (f: any) => f?.product?.id === targetProductId
                  );
                }
              }

              // If we didn't use server-side status filtering, apply client-side
              if (!resolvedStatusIds || resolvedStatusIds.length === 0) {
                // This means we didn't filter server-side, so no client-side filtering needed
              } else if (cursor || resolvedStatusIds.length > 1) {
                // When using cursor OR multiple status IDs, filter client-side
                // (Multiple status IDs aren't sent to server due to API validation errors)
                const set = new Set(resolvedStatusIds);
                out = out.filter(
                  (f: any) => f?.status?.id && set.has(f.status.id)
                );
              }
              // Note: If we used server-side status filtering on the initial call (single status ID),
              // subsequent paginated calls should maintain the same filter

              return out;
            };

            const shouldContinue = () => {
              if (hasError) return false; // Stop if we hit an error
              if (!autoPaginate) return false;
              if (limit && matches.length >= limit) return false;
              if (maxPages && pages >= maxPages) return false;
              return Boolean(next);
            };

            // Helper function to filter fields in response objects
            const filterFields = (item: any) => {
              if (fields.includes("all")) return item;

              const filtered: any = {};
              fields.forEach((field) => {
                switch (field) {
                  case "id":
                    if (item.id) filtered.id = item.id;
                    break;
                  case "name":
                    if (item.name) filtered.name = item.name;
                    break;
                  case "status":
                    if (item.status) {
                      filtered.status = {
                        id: item.status.id,
                        name: item.status.name,
                      };
                    }
                    break;
                  case "product":
                    if (item.product) {
                      filtered.product = {
                        id: item.product.id,
                        name: item.product.name,
                      };
                    }
                    break;
                  case "owner":
                    if (item.owner) {
                      filtered.owner = {
                        id: item.owner.id,
                        name: item.owner.name || item.owner.email,
                      };
                    }
                    break;
                  case "createdAt":
                    if (item.createdAt) filtered.createdAt = item.createdAt;
                    break;
                  case "updatedAt":
                    if (item.updatedAt) filtered.updatedAt = item.updatedAt;
                    break;
                }
              });
              return filtered;
            };

            // Fetch first page (or provided cursor)
            do {
              try {
                let requestUrl: string;
                if (next) {
                  // Use cursor-based URL (could be full URL or cursor token)
                  requestUrl = buildUrlFromCursor(next);
                } else {
                  // First request - use URL with server-side filters
                  requestUrl = buildInitialUrl();
                }

                const resp = await pbFetchWithRetry(requestUrl, 3, 250);
                lastResp = resp;

                // Validate response structure
                if (!resp || typeof resp !== "object") {
                  hasError = true;
                  console.warn(
                    `Invalid response structure from ProductBoard API:`,
                    resp
                  );
                  break;
                }

                const pageItems: any[] = Array.isArray(resp?.data)
                  ? resp.data
                  : [];
                const filtered = await applyFilters(pageItems);

                for (const it of filtered) {
                  if (limit && matches.length >= limit) break;
                  matches.push(filterFields(it));
                }

                // Safely extract next cursor
                const nextCursor = resp?.links?.next;
                if (typeof nextCursor === "string" && nextCursor.length > 0) {
                  next = nextCursor; // can be full URL; will be normalized next loop
                } else {
                  next = undefined; // No more pages
                }

                pages += 1;
              } catch (error) {
                hasError = true;
                console.warn(`Error fetching page ${pages + 1}:`, error);
                // If it's the first page, rethrow the error
                if (pages === 0) {
                  throw error;
                }
                // Otherwise, stop pagination and return what we have
                break;
              }
            } while (shouldContinue());

            // If no autopagination and no cursor provided, we only returned first page filtered
            const payload = {
              ...(lastResp || {}),
              data: limit ? matches.slice(0, limit) : matches,
              // Add pagination metadata for debugging
              _pagination: {
                pages_fetched: pages,
                total_items: matches.length,
                had_error: hasError,
                auto_paginate: autoPaginate,
                max_pages: maxPages,
                limit: limit,
                used_server_side_filtering: !!(
                  resolvedStatusIds && resolvedStatusIds.length > 0
                ),
                api_compliant: true, // Now following ProductBoard API docs
              },
              // If we stopped due to reaching the limit but there is a next page, preserve the cursor
              links: {
                ...(lastResp?.links || {}),
                next: (() => {
                  if (autoPaginate) {
                    if (
                      limit &&
                      matches.length >= (limit || 0) &&
                      lastResp?.links?.next
                    )
                      return lastResp.links.next;
                    return lastResp?.links?.next ?? null;
                  }
                  return lastResp?.links?.next ?? null;
                })(),
              },
            };
            return payload;
          },
        }),

        // Productboard: get feature by id
        pb_get_feature: tool({
          description: "Get details for a specific feature by ID.",
          inputSchema: z.object({ featureId: z.string() }),
          execute: async ({ featureId }) => pbFetch(`/features/${featureId}`),
        }),

        // Productboard: list releases
        pb_list_releases: tool({
          description: "List releases (optionally paginate).",
          inputSchema: z.object({ cursor: z.string().optional() }),
          execute: async ({ cursor }) => {
            // Normalize cursor handling like other pagination tools
            const buildUrl = (c?: string | null): string => {
              if (c && typeof c === "string" && c.trim().length > 0) {
                // Handle cursor - could be full URL, path, or bare token
                const isAbs = /^https?:\/\//i.test(c);
                if (isAbs) return c;
                if (c.startsWith("/")) return c;
                return `/releases?pageCursor=${encodeURIComponent(c)}`;
              }
              return "/releases";
            };

            return pbFetch(buildUrl(cursor));
          },
        }),

        // Productboard: list feature-release assignments
        pb_list_feature_release_assignments: tool({
          description:
            "List feature-release assignments. Returns feature IDs and release IDs (NOT names). Supports auto-pagination and filtering. WARNING: Results are paginated - use autoPaginate=true to get all results.",
          inputSchema: z.object({
            cursor: z.string().optional(),
            autoPaginate: z.boolean().optional(),
            maxPages: z.number().int().min(1).max(10).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            featureId: z.string().optional(),
            releaseId: z.string().optional(),
            releaseState: z
              .enum(["upcoming", "in-progress", "completed"])
              .optional(),
          }),
          execute: async ({
            cursor,
            autoPaginate = true,
            maxPages = 5,
            limit = 100,
            featureId,
            releaseId,
            releaseState,
          }) => {
            const matches: any[] = [];
            let next: string | undefined = cursor;
            let pages = 0;
            let lastResp: any | undefined;
            let hasError = false;

            // Helper function to normalize cursor/URL
            const buildUrl = (c?: string): string => {
              if (c && typeof c === "string" && c.trim().length > 0) {
                // Handle cursor - could be full URL, path, or bare token
                const isAbs = /^https?:\/\//i.test(c);
                if (isAbs) return c;
                if (c.startsWith("/")) return c;
                return `/feature-release-assignments?pageCursor=${encodeURIComponent(
                  c
                )}`;
              }

              // Build base URL with query parameters
              const params = new URLSearchParams();
              if (featureId) params.set("feature.id", featureId);
              if (releaseId) params.set("release.id", releaseId);
              if (releaseState) params.set("release.state", releaseState);

              const queryString = params.toString();
              return `/feature-release-assignments${
                queryString ? `?${queryString}` : ""
              }`;
            };

            const shouldContinue = () => {
              if (hasError) return false;
              if (!autoPaginate) return false;
              if (limit && matches.length >= limit) return false;
              if (maxPages && pages >= maxPages) return false;
              return Boolean(next);
            };

            // Fetch pages
            do {
              try {
                const resp = await pbFetch(buildUrl(next), {
                  headers: {
                    "X-Version": "1",
                  },
                });
                lastResp = resp;

                // Validate response structure
                if (!resp || typeof resp !== "object") {
                  hasError = true;
                  console.warn(
                    `Invalid response structure from ProductBoard API:`,
                    resp
                  );
                  break;
                }

                const pageItems: any[] = Array.isArray(resp?.data)
                  ? resp.data
                  : [];

                for (const item of pageItems) {
                  if (limit && matches.length >= limit) break;
                  matches.push(item);
                }

                // Extract next cursor
                const nextCursor = resp?.links?.next;
                if (typeof nextCursor === "string" && nextCursor.length > 0) {
                  next = nextCursor;
                } else {
                  next = undefined;
                }

                pages += 1;
              } catch (error) {
                hasError = true;
                console.warn(`Error fetching page ${pages + 1}:`, error);
                if (pages === 0) {
                  throw error; // Rethrow if first page fails
                }
                break; // Stop pagination on error
              }
            } while (shouldContinue());

            // Return results with pagination metadata
            const payload = {
              ...(lastResp || {}),
              data: limit ? matches.slice(0, limit) : matches,
              _pagination: {
                pages_fetched: pages,
                total_items: matches.length,
                had_error: hasError,
                auto_paginate: autoPaginate,
                max_pages: maxPages,
                limit: limit,
                next_cursor: lastResp?.links?.next || null,
                filters_applied: {
                  featureId: featureId || null,
                  releaseId: releaseId || null,
                  releaseState: releaseState || null,
                },
              },
            };

            return payload;
          },
        }),

        // Productboard: list objectives
        pb_list_objectives: tool({
          description: "List all objectives.",
          inputSchema: z.object({ cursor: z.string().optional() }),
          execute: async ({ cursor }) => {
            const url =
              cursor && cursor.trim().length > 0 ? cursor : "/objectives";
            return pbFetch(url);
          },
        }),

        // Productboard: list notes summary (optimized for browsing)
        pb_list_notes_summary: tool({
          description:
            "List notes with minimal data for browsing - returns only essential metadata (ID, title, tags, dates, associated features/companies) without full content. Use pb_get_note_details to get full content for specific notes. Supports server-side filtering by companyId.",
          inputSchema: z.object({
            featureId: z.string().optional(),
            companyId: z
              .string()
              .optional()
              .describe("Filter notes by specific company ID"),
            anyTag: z
              .string()
              .optional()
              .describe(
                "Comma-separated list of tags (notes with any of these tags)"
              ),
            allTags: z
              .string()
              .optional()
              .describe(
                "Comma-separated list of tags (notes with all of these tags)"
              ),
            updatedFrom: z
              .string()
              .optional()
              .describe("ISO date - notes updated since this date"),
            updatedTo: z
              .string()
              .optional()
              .describe("ISO date - notes updated before this date"),
            createdFrom: z
              .string()
              .optional()
              .describe("ISO date - notes created since this date"),
            createdTo: z
              .string()
              .optional()
              .describe("ISO date - notes created before this date"),
            term: z.string().optional().describe("Fulltext search term"),
            source: z.string().optional().describe("Filter by source origin"),
            ownerEmail: z.string().optional().describe("Filter by owner email"),
            pageLimit: z.number().int().min(1).max(2000).optional(),
            pageCursor: z
              .string()
              .optional()
              .describe("Pagination cursor from previous response"),
          }),
          execute: async ({
            featureId,
            companyId,
            anyTag,
            allTags,
            updatedFrom,
            updatedTo,
            createdFrom,
            createdTo,
            term,
            source,
            ownerEmail,
            pageLimit = 100,
            pageCursor,
          }) => {
            // Use pageCursor directly if provided (correct parameter name)
            let url;
            if (pageCursor && pageCursor.trim().length > 0) {
              url = `/notes?pageCursor=${encodeURIComponent(pageCursor)}`;
            } else {
              const params = new URLSearchParams();
              if (featureId) params.set("featureId", featureId);
              if (companyId) params.set("companyId", companyId);
              if (anyTag) params.set("anyTag", anyTag);
              if (allTags) params.set("allTags", allTags);
              if (updatedFrom) params.set("updatedFrom", updatedFrom);
              if (updatedTo) params.set("updatedTo", updatedTo);
              if (createdFrom) params.set("createdFrom", createdFrom);
              if (createdTo) params.set("createdTo", createdTo);
              if (term) params.set("term", term);
              if (source) params.set("source", source);
              if (ownerEmail) params.set("ownerEmail", ownerEmail);
              if (pageLimit) params.set("pageLimit", String(pageLimit));
              const qs = params.toString();
              url = `/notes${qs ? `?${qs}` : ""}`;
            }

            const response = await pbFetch(url);

            // Strip content from all results (both initial and paginated)
            if (response.data) {
              response.data = response.data.map((note: any) => ({
                id: note.id,
                title: note.title,
                state: note.state,
                tags: note.tags,
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
                source: note.source,
                company: note.company
                  ? { id: note.company.id, name: note.company.name }
                  : null,
                user: note.user
                  ? { id: note.user.id, name: note.user.name }
                  : null,
                features: note.features
                  ? note.features.map((f: any) => ({
                      id: f.id,
                      name: f.name,
                      importance: f.importance,
                    }))
                  : [],
                owner: note.owner
                  ? { email: note.owner.email, name: note.owner.name }
                  : null,
                // Explicitly omit content field
              }));
            }
            return response;
          },
        }),

        // Productboard: get note details (full content)
        pb_get_note_details: tool({
          description:
            "Get full details for a specific note by ID, including the complete content. Use this after browsing with pb_list_notes_summary to get the full text of specific notes you want to analyze.",
          inputSchema: z.object({
            noteId: z
              .string()
              .describe("The ID of the note to retrieve full details for"),
          }),
          execute: async ({ noteId }) => {
            return pbFetch(`/notes/${noteId}`);
          },
        }),

        // Productboard: list custom fields (requires type string per PB docs)
        pb_list_custom_fields: tool({
          description:
            "List custom field definitions. Requires at least one field type to be specified.",
          inputSchema: z.object({
            types: z
              .array(
                z.enum([
                  "text",
                  "custom-description",
                  "number",
                  "dropdown",
                  "multi-dropdown",
                  "member",
                ])
              )
              .optional(),
            cursor: z.string().optional(),
          }),
          execute: async ({ types, cursor }) => {
            // Handle cursor properly - empty strings and null values
            if (cursor && cursor.trim().length > 0) {
              return pbFetch(cursor);
            }

            // Default to all types if none specified (required parameter)
            const fieldTypes = types || [
              "text",
              "custom-description",
              "number",
              "dropdown",
              "multi-dropdown",
              "member",
            ];

            // Build query parameters
            const params = new URLSearchParams();
            params.set("type", fieldTypes.join(","));

            // Use correct endpoint with required X-Version header
            const url = `/hierarchy-entities/custom-fields?${params.toString()}`;
            return pbFetch(url, {
              headers: {
                "X-Version": "1",
              },
            });
          },
        }),

        // Productboard: get custom field values for entities
        pb_get_custom_field_values: tool({
          description:
            "Get custom field values for hierarchy entities. Returns custom field IDs and entity IDs with their values. Requires either customFieldId or types to be specified.",
          inputSchema: z.object({
            entityType: z.enum(["feature", "component", "product"]).optional(),
            entityIds: z.array(z.string()).optional(),
            customFieldId: z.string().optional(),
            types: z
              .array(
                z.enum([
                  "text",
                  "custom-description",
                  "number",
                  "dropdown",
                  "multi-dropdown",
                  "member",
                ])
              )
              .optional(),
            cursor: z.string().optional(),
          }),
          execute: async ({
            entityType,
            entityIds,
            customFieldId,
            types,
            cursor,
          }) => {
            // Handle cursor properly - empty strings and null values
            if (cursor && cursor.trim().length > 0) {
              return pbFetch(cursor);
            }

            // Build query parameters - either customField.id or type is required
            const params = new URLSearchParams();

            if (customFieldId) {
              params.set("customField.id", customFieldId);
            } else {
              // Default to all types if no customFieldId specified (required parameter)
              const fieldTypes = types || [
                "text",
                "custom-description",
                "number",
                "dropdown",
                "multi-dropdown",
                "member",
              ];
              params.set("type", fieldTypes.join(","));
            }

            // Add hierarchyEntity.id filters if provided
            if (entityIds && entityIds.length > 0) {
              entityIds.forEach((id) =>
                params.append("hierarchyEntity.id", id)
              );
            }

            // Use correct endpoint with required X-Version header
            const url = `/hierarchy-entities/custom-fields-values?${params.toString()}`;
            return pbFetch(url, {
              headers: {
                "X-Version": "1",
              },
            });
          },
        }),
      },
    });
  },
  async webhook(request) {
    if (slackbot.isOAuthRequest(request)) {
      return slackbot.handleOAuthRequest(request);
    }
    if (slackbot.isWebhook(request)) {
      return slackbot.handleWebhook(request);
    }
  },
});
