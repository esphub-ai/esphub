export const issuer = "https://clerk.esphub.ai";
export const portal = "https://accounts.esphub.ai";
export const application = "https://app.esphub.ai";
export const apiOrigin = "https://api.esphub.ai";
export const boardPhotoOrigin = "https://cdn.esphub.ai";
export const browserOrigins = [
  "https://esphub.ai",
  "https://www.esphub.ai",
  application,
];
export const mcpEndpoint = apiOrigin + "/mcp";
export function releaseUrl(board, asset, tag) {
  const url = `${apiOrigin}/releases/${board}/${asset}`;
  return tag ? url + "?tag=" + encodeURIComponent(tag) : url;
}
