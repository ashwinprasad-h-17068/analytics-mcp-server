#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMetaDataTools } from "./tools/metadata-tools";
import { registerModellingTools } from "./tools/modelling-tools";
import { registerDataTools } from "./tools/data-tools";
import { registerRowTools } from "./tools/row-tools";


const server = new McpServer({
  name: "zoho-analytics",
  version: "1.0.0"
});

registerMetaDataTools(server);
registerModellingTools(server);
registerDataTools(server);
registerRowTools(server);


const transport = new StdioServerTransport();
(async () => {
  await server.connect(transport);
  console.log("Zoho Analytics MCP server is running and connected to stdin/stdout::v1.0.3");
})();
