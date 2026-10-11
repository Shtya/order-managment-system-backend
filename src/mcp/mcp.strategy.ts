import { McpStrategy, StreamableHttpTransport } from "@rekog/mcp-nest";

// One transport instance, shared by the strategy and the HTTP controller.
// Stateless + JSON by default, which is what ChatGPT and Claude expect.
export const mcpTransport = new StreamableHttpTransport();

// In v2 the strategy IS the configuration. There is no McpModule.
export const mcp = new McpStrategy({
  name: "madar-mcp",
  version: "1.0.0",
  transports: [mcpTransport],
});
