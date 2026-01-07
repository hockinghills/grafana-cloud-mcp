# Grafana Cloud MCP Server

A Cloudflare Workers-based Model Context Protocol (MCP) server that enables AI assistants like Claude to manage your Grafana Cloud account - including dashboards, alerts, data sources, and more.

## Features

### Dashboard Management
- List, create, update, and delete dashboards
- Add panels with various visualization types
- Configure queries and data sources per panel

### Alert Management
- List and manage alert rules
- Create alerts with PromQL/LogQL conditions
- Configure contact points (Slack, Email, PagerDuty, etc.)

### Data Source Management
- List and configure data sources
- Support for Prometheus, Loki, Elasticsearch, and more
- Test data source connectivity

### Additional Tools
- Folder management for organization
- Annotations for marking events
- Direct metric queries
- Health checks and authentication verification

## Setup

### Prerequisites

1. A Grafana Cloud account with a [Service Account Token](https://grafana.com/docs/grafana-cloud/account-management/authentication-and-permissions/service-accounts/)
2. A Cloudflare account with Workers enabled
3. Node.js 18+ and npm

### Installation

```bash
git clone https://github.com/hockinghills/grafana-cloud-mcp.git
cd grafana-cloud-mcp
npm install
```

> **Note:** `npm audit` may report vulnerabilities in `@modelcontextprotocol/sdk`. These are patched locally via `patch-package` (applied automatically during install). The warnings appear because npm checks version numbers, not the actual patched code.

### Configuration

1. **KV namespaces (already configured):**

   The repository includes pre-configured KV namespace IDs for OAuth token storage:
   - Development: Used with `wrangler dev` and `npm run deploy`
   - Production: Used with `npm run deploy -- --env production`

   If you're forking this repo for your own use, create your own namespaces:
   ```bash
   # Development namespace
   wrangler kv namespace create OAUTH_KV

   # Production namespace (separate for data isolation)
   wrangler kv namespace create OAUTH_KV --env production
   ```
   Update `wrangler.toml` with the returned IDs.

2. **Set the cookie encryption key (REQUIRED):**
   ```bash
   # Generate a secure key
   openssl rand -base64 32

   # Set it as a secret (for default environment)
   wrangler secret put COOKIE_ENCRYPTION_KEY

   # Also set for production if using --env production
   wrangler secret put COOKIE_ENCRYPTION_KEY --env production
   ```

3. **(Optional) Restrict CORS origin:**
   ```bash
   # By default, CORS allows any origin (*). To restrict to specific origins:
   wrangler secret put ALLOWED_ORIGIN
   wrangler secret put ALLOWED_ORIGIN --env production  # if using production env
   ```

### Development

```bash
npm run dev
```

This starts a local development server at `http://localhost:8787`.

### Deployment

**Development/default deployment:**
```bash
npm run deploy
```

**Production deployment (recommended):**
```bash
npm run deploy -- --env production
```

Production deployment uses a separate KV namespace to isolate OAuth tokens from development data.

## Usage

This server uses OAuth authentication - you'll enter your Grafana Cloud credentials (URL and service account token) during the OAuth flow when connecting from Claude.

---

### Claude Web (claude.ai)

Connect Claude to your Grafana Cloud via OAuth:

1. Go to [claude.ai](https://claude.ai) → Settings → Integrations
2. Click "Add Integration" or "Add custom connector"
3. Enter the server URL: `https://YOUR-WORKER.workers.dev`
4. Click "Connect" to start the OAuth flow
5. Enter your Grafana Cloud URL and Service Account Token
6. Once authenticated, Claude can manage your Grafana Cloud

Your Grafana credentials are validated against the Grafana API and then stored securely as an OAuth token.

---

### Claude Code Setup

Add this MCP server to Claude Code:

```bash
claude mcp add grafana-cloud \
  --transport sse \
  --url https://YOUR-WORKER.workers.dev/sse
```

When you first use the Grafana tools, you'll be prompted to complete the OAuth flow and enter your Grafana credentials.

To verify it's working:
```bash
claude mcp list
```

To remove later:
```bash
claude mcp remove grafana-cloud
```

---

### Claude Desktop App

Add to your Claude Desktop config file:

**Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**Linux**: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "grafana-cloud": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://YOUR-WORKER.workers.dev/sse"
      ]
    }
  }
}
```

On first use, you'll be prompted to complete the OAuth flow.

---

### Available Tools

| Tool | Description |
|------|-------------|
| `grafana_health_check` | Verify Grafana Cloud connection and authentication |
| `grafana_list_dashboards` | List all dashboards (with optional filters) |
| `grafana_get_dashboard` | Get a dashboard by UID |
| `grafana_create_dashboard` | Create a new dashboard with panels |
| `grafana_update_dashboard` | Update an existing dashboard |
| `grafana_delete_dashboard` | Delete a dashboard |
| `grafana_list_datasources` | List all data sources |
| `grafana_get_datasource` | Get data source details |
| `grafana_create_datasource` | Create a new data source |
| `grafana_delete_datasource` | Delete a data source |
| `grafana_test_datasource` | Test data source connectivity |
| `grafana_list_alert_rules` | List all alert rules |
| `grafana_get_alert_rule` | Get alert rule details |
| `grafana_create_alert_rule` | Create a new alert rule |
| `grafana_delete_alert_rule` | Delete an alert rule |
| `grafana_list_contact_points` | List notification contact points |
| `grafana_create_contact_point` | Create a contact point |
| `grafana_delete_contact_point` | Delete a contact point |
| `grafana_list_folders` | List all folders |
| `grafana_create_folder` | Create a new folder |
| `grafana_delete_folder` | Delete a folder |
| `grafana_list_annotations` | List annotations |
| `grafana_create_annotation` | Create an annotation |
| `grafana_delete_annotation` | Delete an annotation |
| `grafana_query_metrics` | Query metrics from a data source |

## Example Conversations

### Create a Dashboard

> "Create a dashboard called 'API Metrics' with a timeseries panel showing request rate from my Prometheus data source"

### Set Up an Alert

> "Create an alert that fires when CPU usage exceeds 80% for more than 5 minutes"

### Query Metrics

> "Show me the current request rate from the prometheus data source"

## Service Account Permissions

Your Grafana Cloud service account needs appropriate permissions. Recommended roles:

- **Dashboards**: `dashboards:write`, `dashboards:delete`
- **Alerts**: `alert.provisioning:write`
- **Data Sources**: `datasources:write`, `datasources:delete`
- **Folders**: `folders:write`, `folders:delete`
- **Annotations**: `annotations:write`

## API Reference

The server implements the following Grafana Cloud API endpoints:

- [Dashboard API](https://grafana.com/docs/grafana/latest/developers/http_api/dashboard/)
- [Data Source API](https://grafana.com/docs/grafana/latest/developers/http_api/data_source/)
- [Alerting Provisioning API](https://grafana.com/docs/grafana/latest/developers/http_api/alerting_provisioning/)
- [Folder API](https://grafana.com/docs/grafana/latest/developers/http_api/folder/)
- [Annotation API](https://grafana.com/docs/grafana/latest/developers/http_api/annotations/)

## Security

- **OAuth Authentication**: All MCP connections use OAuth 2.1 with PKCE for secure authentication
- **CSRF Protection**: OAuth flow includes CSRF token validation
- **Secure Session Cookies**: OAuth state is bound to session cookies with `__Host-` prefix, `Secure`, `HttpOnly`, and `SameSite` attributes
- **Credential Validation**: Grafana credentials are validated against the Grafana API before issuing tokens
- **Encrypted Storage**: OAuth tokens and credentials are stored in Cloudflare KV (encrypted at rest)
- **HTTPS Only**: All API communication uses HTTPS
- **Error Sanitization**: Error messages are sanitized to prevent leaking internal details
- **Least Privilege**: The MCP server only exposes operations you've granted permissions for

## License

MIT
