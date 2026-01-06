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

### Configuration

1. Set your Grafana Cloud credentials as secrets:
   ```bash
   wrangler secret put GRAFANA_CLOUD_URL
   # Enter your Grafana Cloud URL (e.g., https://myorg.grafana.net)

   wrangler secret put GRAFANA_SERVICE_ACCOUNT_TOKEN
   # Enter your service account token
   ```

2. **Set an API key for endpoint authentication (REQUIRED):**
   ```bash
   # Generate a secure API key
   openssl rand -base64 32

   # Set it as a secret
   wrangler secret put MCP_API_KEY
   # Enter your generated API key
   ```

3. **(Optional) Restrict CORS origin:**
   ```bash
   # By default, CORS allows any origin (*). To restrict to specific origins:
   wrangler secret put ALLOWED_ORIGIN
   # Enter your allowed origin (e.g., https://claude.ai)
   ```

### Development

```bash
npm run dev
```

This starts a local development server at `http://localhost:8787`.

### Deployment

```bash
npm run deploy
```

## Usage

### Generating Your API Key

Before connecting any client, generate a secure API key:

```bash
# Option 1: Using openssl (Linux/Mac)
openssl rand -base64 32

# Option 2: Using Python (cross-platform)
python3 -c "import secrets; print(secrets.token_urlsafe(32))"

# Option 3: Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Save the generated key somewhere secure - you'll need it for both:
1. Setting the `MCP_API_KEY` secret in Cloudflare (`wrangler secret put MCP_API_KEY`)
2. Configuring your MCP client (Claude Code or Claude browser)

---

### Claude Code Setup

The easiest way to add this MCP server to Claude Code:

```bash
claude mcp add grafana-cloud \
  --transport sse \
  --url https://YOUR-WORKER.workers.dev/sse \
  --header "Authorization: Bearer YOUR_API_KEY"
```

Replace:
- `YOUR-WORKER.workers.dev` with your deployed worker URL
- `YOUR_API_KEY` with the API key you generated

To verify it's working:
```bash
claude mcp list
```

To remove later:
```bash
claude mcp remove grafana-cloud
```

---

### Claude Browser Setup (claude.ai)

1. Go to [claude.ai](https://claude.ai) and open Settings
2. Navigate to **Integrations** → **Model Context Protocol (MCP)**
3. Click **Add MCP Server**
4. Enter the following:
   - **Name**: `grafana-cloud`
   - **URL**: `https://YOUR-WORKER.workers.dev/sse`
   - **Authentication**: Select "Bearer Token" and enter your API key

The server will now be available in your Claude conversations. You can verify by asking Claude: "What Grafana tools do you have available?"

---

### Manual Configuration (Claude Desktop App)

If you prefer manual configuration, add to your Claude Desktop config file:

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
        "https://YOUR-WORKER.workers.dev/sse",
        "--header",
        "Authorization: Bearer YOUR_API_KEY"
      ]
    }
  }
}
```

---

### Authentication Notes

The API key must be provided via HTTP headers:
- `Authorization: Bearer YOUR_KEY`
- `X-API-Key: YOUR_KEY` (alternative)

Query parameters are **not supported** for security reasons - keys in URLs leak via referer headers and server logs.

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

- **API Key Authentication**: MCP endpoints (`/sse`, `/mcp`) require a valid API key. The server fails closed - requests are rejected if `MCP_API_KEY` is not configured.
- **Configurable CORS**: Set `ALLOWED_ORIGIN` to restrict which origins can access the API (defaults to `*` if not set)
- **Secrets Management**: All credentials are stored as Cloudflare Worker secrets (encrypted at rest)
- **HTTPS Only**: All API communication uses HTTPS
- **Error Sanitization**: Error messages are sanitized to prevent leaking internal details
- **Timing-Safe Comparison**: API key validation uses constant-time comparison to prevent timing attacks
- **Least Privilege**: The MCP server only exposes operations you've granted permissions for

⚠️ **Important**: `MCP_API_KEY` is required. The server will return HTTP 500 if it's not configured.

## License

MIT
