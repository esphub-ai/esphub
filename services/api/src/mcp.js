import { createClerkClient } from "@clerk/backend";
import {
  McpAuthError,
  McpTokenVerificationError,
  authorizationServerMetadataHandler,
  mcpAuth,
  protectedResourceMetadataHandler,
  requireAdditionalScopes,
  toClerkAuthInfo,
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

const verificationUnavailable = new Set([
  "unexpected-error",
  "secret-key-invalid",
  "jwk-remote-failed-to-load",
]);

function clerkStatus(message) {
  const status = /\(code=[^,()]*, status=(\d{3})\)$/.exec(message ?? "")?.[1];
  return status === undefined ? undefined : Number(status);
}

function isVerificationUnavailable(reason, message, status) {
  if (reason === "token-verification-failed")
    return message.startsWith("Error loading Clerk JWKS");
  if (!verificationUnavailable.has(reason)) return false;
  return (
    status === undefined ||
    status < 400 ||
    status >= 500 ||
    status === 401 ||
    status === 429
  );
}

async function verifyMcpToken(token, c) {
  if (!c.env.CLERK_SECRET_KEY || !c.env.CLERK_PUBLISHABLE_KEY) {
    throw new McpAuthError(new Error("Clerk authentication is not configured"));
  }
  const clerk = createClerkClient({
    secretKey: c.env.CLERK_SECRET_KEY,
    publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
    ...(c.env.CLERK_API_URL ? { apiUrl: c.env.CLERK_API_URL } : {}),
    ...(c.env.CLERK_API_VERSION ? { apiVersion: c.env.CLERK_API_VERSION } : {}),
    ...(c.env.CLERK_JWT_KEY ? { jwtKey: c.env.CLERK_JWT_KEY } : {}),
  });
  const state = await clerk.authenticateRequest(
    new Request(mcpEndpoint, {
      headers: { authorization: `Bearer ${token}` },
    }),
    {
      acceptsToken: ["oauth_token", "api_key"],
      audience: mcpEndpoint,
    },
  );
  if (!state.isAuthenticated) {
    const { reason, message } = state;
    const status = clerkStatus(message);
    const error = new McpTokenVerificationError(
      reason,
      message || `Clerk did not accept the token (${reason})`,
      { status },
    );
    if (isVerificationUnavailable(reason, message ?? "", status))
      throw new McpAuthError(error);
    throw error;
  }
  const auth = state.toAuth();
  if (auth.tokenType === "oauth_token") {
    const authInfo = toClerkAuthInfo(auth, token);
    if (!authInfo) {
      throw new McpTokenVerificationError(
        "token-claims-missing",
        "Clerk verified the token, but its auth object is incomplete",
      );
    }
    return authInfo;
  }
  if (auth.tokenType === "api_key") {
    if (!auth.userId) {
      throw new McpTokenVerificationError(
        "token-claims-missing",
        "Personal user API key required",
      );
    }
    return {
      token,
      clientId: auth.id,
      scopes: ["devices:read", "devices:write"],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      extra: { userId: auth.userId },
    };
  }
  throw new McpTokenVerificationError(
    "token-type-mismatch",
    "Unsupported token type",
  );
}

const options = {
  resourceUrl: mcpEndpoint,
  requiredScopes: ["devices:read"],
  challengeScopes: ["devices:write", "offline_access"],
};
export const authenticateMcp = mcpAuth({
  ...options,
  verifyToken: verifyMcpToken,
});
const writeAccess = requireAdditionalScopes("devices:write");
// Read scope covers read-only tools that stay on EspHub. An active Wi-Fi scan
// observes nearby networks, so it also needs write scope.
const readTools = new Set(
  tools
    .filter(({ annotations }) => annotations.readOnlyHint && !annotations.openWorldHint)
    .map(({ name }) => name),
);
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
                const account =
                  name === "boards_search" || name === "projects_search"
                    ? null
                    : await accountForSubject(sql, authInfo.extra.userId, c.env);
                return operate(
                  { env: c.env, sql, isStaff: Boolean(account?.is_staff) },
                  account?.owner,
                  name,
                  args,
                );
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
