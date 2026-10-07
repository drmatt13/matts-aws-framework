export function consumeLaunchToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (token) {
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return token;
}

export function connectionUrlWithToken(value: string, token: string | null): string {
  if (!value || !token) return value;
  const url = new URL(value);
  url.searchParams.set("token", token);
  return url.toString();
}
