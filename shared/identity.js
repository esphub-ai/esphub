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
// Kept solely so historical migration 017 can replay on fresh databases.
export function releaseUrl(board, asset, tag) {
  const url = `${apiOrigin}/releases/${board}/${asset}`;
  return tag ? url + "?tag=" + encodeURIComponent(tag) : url;
}
export function bootloaderUrl(id, version, file) {
  return `${apiOrigin}/bootloaders/${id}/${version}/${file}`;
}
export function projectAppUrl(projectId, boardId, version) {
  return version === undefined
    ? `${apiOrigin}/projects/${projectId}/boards/${boardId}/app`
    : `${apiOrigin}/projects/${projectId}/boards/${boardId}/releases/${encodeURIComponent(version)}/app`;
}
export function projectImageUrl(projectId, sha256, ext) {
  return `${boardPhotoOrigin}/projects/${projectId}/images/${sha256}.${ext}`;
}
