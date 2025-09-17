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

async function pbFetch(input: string | URL, init?: RequestInit) {
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

export default blink.agent({
  displayName: "productboard-agent",

  async sendMessages({ messages }) {
    return streamText({
      model: "openai/gpt-5-mini",
      system: `You are a basic agent the user will customize.\n\nSuggest the user adds tools to the agent. Demonstrate your capabilities with the IP tool.`,
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

        // Productboard: list features
        pb_list_features: tool({
          description:
            "List features with optional filters. Defaults to product 'coder' when productId is omitted.",
          inputSchema: z.object({
            productId: z.string().optional(),
            statusIds: z.array(z.string()).optional(),
            releaseId: z.string().optional(),
            updatedSince: z.string().optional(), // ISO8601
            limit: z.number().int().min(1).max(100).optional(),
            cursor: z.string().optional(),
          }),
          execute: async ({
            productId,
            statusIds,
            releaseId,
            updatedSince,
            limit,
            cursor,
          }) => {
            if (cursor) return pbFetch(cursor);
            const params = new URLSearchParams();
            const finalProductId =
              productId ?? (await getDefaultCoderProductId());
            if (finalProductId) params.set("productId", finalProductId);
            if (releaseId) params.set("releaseId", releaseId);
            if (updatedSince) params.set("updatedSince", updatedSince);
            if (limit) params.set("limit", String(limit));
            if (statusIds && statusIds.length) {
              for (const s of statusIds) params.append("statusId", s);
            }
            return pbFetch(`/features?${params.toString()}`);
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

        // Productboard: list initiatives
        pb_list_initiatives: tool({
          description: "List all initiatives.",
          inputSchema: z.object({ cursor: z.string().optional() }),
          execute: async ({ cursor }) => pbFetch(cursor ?? "/initiatives"),
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
            "List custom field definitions. PB recommends specifying a 'type' filter to remain forward-compatible.",
          inputSchema: z.object({
            type: z.string().optional(),
            cursor: z.string().optional(),
          }),
          execute: async ({ type, cursor }) => {
            if (cursor) return pbFetch(cursor);
            const params = new URLSearchParams();
            if (type) params.set("type", type);
            const qs = params.toString();
            return pbFetch(`/custom-fields${qs ? `?${qs}` : ""}`);
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
