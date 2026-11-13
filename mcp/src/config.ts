export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Where the MCP reaches Drupal. On the VM this is the Docker network name. */
  ccrUrl: process.env.CCR_INTERNAL_URL ?? 'http://ccr-mcp.ddev.site',
  keys: process.env.MCP_KEYS,
};
