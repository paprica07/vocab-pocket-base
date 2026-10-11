import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@/server/routers";
import { getApiBaseUrl } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";

export const trpc = createTRPCReact<AppRouter>();

function resolveApiUrl() {
  const baseUrl = getApiBaseUrl();

  if (baseUrl && baseUrl.startsWith("http")) {
    return `${baseUrl}/api/trpc`;
  }

  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api/trpc`;
  }

  return "https://vocab-pocket.onrender.com/api/trpc";
}

export function createTRPCClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: resolveApiUrl(),
        transformer: superjson,

        async headers() {
          const token = await Auth.getSessionToken();
          return token ? { Authorization: `Bearer ${token}` } : {};
        },

        fetch(url, options) {
          console.log("[tRPC DEBUG] request URL:", url);
          console.log("[tRPC DEBUG] method:", options?.method);

          return fetch(url, {
            ...options,
            credentials: "include",
          });
        },
      }),
    ],
  });
}