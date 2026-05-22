/** Remove one or more trailing slashes from a URL string. */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
