import {
  authorizationServerMetadataHandler,
  mcpAuth,
  protectedResourceMetadataHandler,
  requireAdditionalScopes,
} from "@clerk/mcp-tools/hono";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import { HTTPException } from "hono/http-exception";
import { mcpEndpoint } from "../../../shared/identity.js";
import { accountForSubject } from "./auth.js";
import { withDatabase } from "./database.js";
import { operate, tools } from "./operations.js";
import { reconnectGuidance } from "./provisioning.js";

const options = {
  resourceUrl: mcpEndpoint,
  requiredScopes: ["devices:read"],
  challengeScopes: ["devices:write", "offline_access"],
};
export const authenticateMcp = mcpAuth(options);
const writeAccess = requireAdditionalScopes("devices:write");
const readTools = new Set([
  "boards.search",
  "commands.get",
  "logs.read",
  "devices.list",
  "devices.get",
  "wifi.list",
  "firmware.get",
]);
export function installMcpMetadata(app) {
  const resource = protectedResourceMetadataHandler(options);
  app.on(
    ["GET", "OPTIONS"],
    [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ],
    resource,
  );
  app.on(
    ["GET", "OPTIONS"],
    "/.well-known/oauth-authorization-server",
    authorizationServerMetadataHandler(),
  );
}
export async function serveMcp(c) {
  const authInfo = c.get("mcpAuth");
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "esphub", title: "EspHub", version: "1.0.0" },
        { instructions: reconnectGuidance },
      );
      for (const { name, description, inputSchema, annotations } of tools) {
        server.registerTool(
          name,
          {
            description,
            annotations,
            inputSchema: fromJsonSchema(inputSchema),
            scopeChallenge: readTools.has(name) ? undefined : writeAccess,
          },
          async (args) => {
            try {
              const result = await withDatabase(c.env, async (sql) => {
                const owner =
                  name === "boards.search"
                    ? undefined
                    : (await accountForSubject(sql, authInfo.extra.userId)).owner;
                return operate({ env: c.env, sql }, owner, name, args);
              });
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            } catch (error) {
              if (!(error instanceof HTTPException))
                console.error("MCP tool failed", error.name, error.code);
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      error instanceof HTTPException
                        ? error.message
                        : "Operation failed",
                  },
                ],
              };
            }
          },
        );
      }
      return server;
    },
    { maxRequestBodySize: 65536 },
  );
  return handler.fetch(c.req.raw, { authInfo });
}
