// Output values are literal data. Compose decodes double-quoted escapes and
// treats \$ as a literal dollar sign rather than another environment reference.
export function quoteOutputValue(value) {
  return /^[A-Za-z0-9_./:@?=+-]*$/.test(value)
    ? value
    : JSON.stringify(value).replaceAll("$", "\\$");
}
