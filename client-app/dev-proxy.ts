/** Agent routes match exactly; HTTP routes retain their /api prefix at the local server. */
export function developmentApiProxy(
  target: string,
  agentRoutes: Readonly<Record<string, string>>,
): Record<string, { readonly target: string; readonly changeOrigin: boolean }> {
  const exactPattern = (path: string) => `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\?|$)`;
  return {
    ...Object.fromEntries(Object.values(agentRoutes).map((path) => [exactPattern(path), {
      target,
      changeOrigin: true,
    }])),
    "^/api(?:/|\\?|$)": { target, changeOrigin: true },
  };
}
