import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// Create server instance
const server = new McpServer({
    name: "protonmail-mcp",
    version: "1.0.0",
});
server.registerTool("send-email", {
    description: "Send an email to a recipient",
    inputSchema: z.object({
        recipient: z.email(),
        subject: z.string(),
        body: z.string(),
    }),
}, async ({ recipient, subject, body }) => {
    console.error(`Sending email to ${recipient} with subject ${subject} and body ${body}`);
    return {
        content: [
            {
                type: "text",
                text: "email sent successfully",
            }
        ]
    };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Protonmail MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
