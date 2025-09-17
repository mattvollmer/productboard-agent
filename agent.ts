import { streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";
import { convertToModelMessages } from "ai";

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
    (p: any) => (p?.name || "").toLowerCase() === "coder",
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
  baseDelayMs = 250,
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
      model: "openai/gpt-5-mini",
      system: `You are the Productboard data assistant for Coder's GTM and product teams.

Operate strictly via the provided tools to read Productboard data. Do not invent endpoints or parameters.

Defaults and scope
- Default product is the one named "coder" when no productId is provided.
- Time horizon of interest is the next 1–2 quarters, but do not filter by time unless explicitly asked.
- Privacy: surfacing customer names and quotes is allowed.

How to answer common questions
- "What are we currently working on?":
  1) List feature statuses and identify in-progress ones.
  2) List features and filter client-side by the in-progress status IDs and the coder product.
- "What’s coming next?": use releases if available, otherwise return features by status; ask for clarification if needed.

Tooling rules
- Use pagination when links.next is present by accepting/propagating cursor.
- For features: call GET /features without unsupported query params and filter client-side (product, statusIds, limit).
- On errors, return the HTTP code and a concise explanation of what to try next.

Response style
- Be concise and actionable. Provide small, structured lists with: title, status, release (if any), and ID.
- Do not expose chain-of-thought; summarize actions taken only when helpful.
- No notifications or scheduling yet; read-only operations only.
`,
      messages: convertToModelMessages(messages),
      tools: {
        // Productboard: list products
        pb_list_products: tool({
          description: "List all Productboard products in the workspace.",
          inputSchema: z.object({ cursor: z.string().optional() }),
          execute: async ({ cursor }) => {
            return pbFetch(cursor ?? "/products");
          },
        }),

        // Productboard: list feature statuses
        pb_list_feature_statuses: tool({
          description: "List all feature statuses (workspace taxonomy).",
          inputSchema: z.object({}),
          execute: async () => pbFetch("/feature-statuses"),
        }),

        // Productboard: list features (client-side filtering + optional autopagination)
        pb_list_features: tool({
          description:
            "List features with optional client-side filters. Defaults to product 'coder' when productId is omitted. Returns only essential fields to avoid context window issues.",
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
                  "description",
                  "status",
                  "product",
                  "owner",
                  "createdAt",
                  "updatedAt",
                  "all",
                ]),
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
                statusNames.map((s: string) => s.toLowerCase()),
              );
              resolvedStatusIds = allStatuses
                .filter(
                  (st: any) =>
                    st?.name && wanted.has(String(st.name).toLowerCase()),
                )
                .map((st: any) => String(st.id));
            }

            const matches: any[] = [];
            let next: string | undefined = cursor;
            let pages = 0;
            let lastResp: any | undefined;
            let hasError = false;

            const applyFilters = async (arr: any[]) => {
              let out = arr;
              const hasProductField = out.some(
                (f: any) => f && f.product && f.product.id,
              );
              if (hasProductField) {
                const targetProductId =
                  productId ??
                  (defaultCoderProductId ||
                    (defaultCoderProductId = await getDefaultCoderProductId()));
                if (targetProductId) {
                  out = out.filter(
                    (f: any) => f?.product?.id === targetProductId,
                  );
                }
              }
              if (resolvedStatusIds && resolvedStatusIds.length) {
                const set = new Set(resolvedStatusIds);
                out = out.filter(
                  (f: any) => f?.status?.id && set.has(f.status.id),
                );
              }
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
                  case "description":
                    if (item.description) {
                      // Truncate long descriptions to avoid context bloat
                      const desc = String(item.description);
                      filtered.description =
                        desc.length > 500
                          ? desc.substring(0, 500) + "..."
                          : desc;
                    }
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
                const resp = await pbFetchWithRetry(
                  next ?? "/features",
                  3,
                  250,
                );
                lastResp = resp;

                // Validate response structure
                if (!resp || typeof resp !== "object") {
                  hasError = true;
                  console.warn(
                    `Invalid response structure from ProductBoard API:`,
                    resp,
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
                  next = nextCursor;
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
          execute: async ({ cursor }) => pbFetch(cursor ?? "/releases"),
        }),

        // Productboard: list feature-release assignments
        pb_list_feature_release_assignments: tool({
          description:
            "List feature-release assignments, optionally filtered by releaseId or featureId.",
          inputSchema: z.object({
            releaseId: z.string().optional(),
            featureId: z.string().optional(),
            cursor: z.string().optional(),
            limit: z.number().int().min(1).max(100).optional(),
          }),
          execute: async ({ releaseId, featureId, cursor, limit }) => {
            if (cursor) return pbFetch(cursor);
            const params = new URLSearchParams();
            if (releaseId) params.set("releaseId", releaseId);
            if (featureId) params.set("featureId", featureId);
            if (limit) params.set("limit", String(limit));
            const qs = params.toString();
            return pbFetch(`/feature-release-assignments${qs ? `?${qs}` : ""}`);
          },
        }),

        // Productboard: list objectives
        pb_list_objectives: tool({
          description: "List all objectives.",
          inputSchema: z.object({ cursor: z.string().optional() }),
          execute: async ({ cursor }) => pbFetch(cursor ?? "/objectives"),
        }),

        // Productboard: list links (relations between entities)
        pb_list_links: tool({
          description:
            "List links between entities (e.g., objective->feature, initiative->feature). Provide fromType/toType and fromId or toId.",
          inputSchema: z.object({
            fromType: z.enum(["feature", "initiative", "objective"]).optional(),
            toType: z.enum(["feature", "initiative", "objective"]).optional(),
            fromId: z.string().optional(),
            toId: z.string().optional(),
            cursor: z.string().optional(),
            limit: z.number().int().min(1).max(100).optional(),
          }),
          execute: async ({
            fromType,
            toType,
            fromId,
            toId,
            cursor,
            limit,
          }) => {
            if (cursor) return pbFetch(cursor);
            if (!fromId && !toId) throw new Error("fromId or toId is required");
            const params = new URLSearchParams();
            if (fromType) params.set("fromType", fromType);
            if (toType) params.set("toType", toType);
            if (fromId) params.set("fromId", fromId);
            if (toId) params.set("toId", toId);
            if (limit) params.set("limit", String(limit));
            return pbFetch(`/links?${params.toString()}`);
          },
        }),

        // Productboard: list notes (insights)
        pb_list_notes: tool({
          description:
            "List notes. Optionally filter by featureId, tag, or updatedSince. Returns full PB response with pagination links.",
          inputSchema: z.object({
            featureId: z.string().optional(),
            tag: z.string().optional(),
            updatedSince: z.string().optional(), // ISO8601
            limit: z.number().int().min(1).max(100).optional(),
            cursor: z.string().optional(),
          }),
          execute: async ({ featureId, tag, updatedSince, limit, cursor }) => {
            if (cursor) return pbFetch(cursor);
            const params = new URLSearchParams();
            if (featureId) params.set("featureId", featureId);
            if (tag) params.set("tag", tag);
            if (updatedSince) params.set("updatedSince", updatedSince);
            if (limit) params.set("limit", String(limit));
            const qs = params.toString();
            return pbFetch(`/notes${qs ? `?${qs}` : ""}`);
          },
        }),

        // Productboard: list tags
        pb_list_tags: tool({
          description: "List all tags.",
          inputSchema: z.object({ cursor: z.string().optional() }),
          execute: async ({ cursor }) => pbFetch(cursor ?? "/tags"),
        }),

        // Productboard: list custom fields (requires type string per PB docs)
        pb_list_custom_fields: tool({
          description:
            "List custom field definitions. Accepts optional type or entityType; will probe API variants if needed.",
          inputSchema: z.object({
            type: z.string().optional(),
            entityType: z.string().optional(),
            cursor: z.string().optional(),
          }),
          execute: async ({ type, entityType, cursor }) => {
            if (cursor) return pbFetch(cursor);
            const t = type ?? entityType ?? "feature";
            const attempts = [
              `/custom-fields?type=${encodeURIComponent(t)}`,
              `/custom-fields?entityType=${encodeURIComponent(t)}`,
              `/custom-fields`,
            ];
            const tried: string[] = [];
            let lastErr: any;
            for (const url of attempts) {
              tried.push(url);
              try {
                const res = await pbFetchWithRetry(url, 3, 250);
                return { ...res, meta: { variant: url, tried } };
              } catch (err) {
                lastErr = err;
              }
            }
            const msg =
              lastErr instanceof Error ? lastErr.message : String(lastErr);
            throw new Error(
              `Failed to list custom fields after attempts: ${tried.join(
                ", ",
              )} -> ${msg}`,
            );
          },
        }),

        // Productboard: get custom field values for entities
        pb_get_custom_field_values: tool({
          description:
            "Get custom field values for specific entities (e.g., features). Provide entityType and entityIds; optionally customFieldIds.",
          inputSchema: z.object({
            entityType: z
              .enum(["feature", "initiative", "objective", "product"])
              .default("feature"),
            entityIds: z.array(z.string()).min(1),
            customFieldIds: z.array(z.string()).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            cursor: z.string().optional(),
          }),
          execute: async ({
            entityType,
            entityIds,
            customFieldIds,
            limit,
            cursor,
          }) => {
            if (cursor) return pbFetch(cursor);
            const params = new URLSearchParams();
            params.set("entityType", entityType);
            for (const id of entityIds) params.append("entityId", id);
            if (customFieldIds)
              for (const cf of customFieldIds)
                params.append("customFieldId", cf);
            if (limit) params.set("limit", String(limit));
            return pbFetch(`/custom-fields/values?${params.toString()}`);
          },
        }),
      },
    });
  },
});
