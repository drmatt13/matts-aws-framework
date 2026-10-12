// Resolve the stored theme before first paint. Keep this script synchronous;
// script-src 'self' permits it without an inline-script exception.
try {
  var mode = localStorage.getItem("theme");
  if (mode !== "light" && mode !== "dark") mode = "auto";
  var resolved =
    mode === "auto"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
  var root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  root.style.colorScheme = resolved;
} catch (e) {
  // Private mode can throw on localStorage; the light default stands.
}
