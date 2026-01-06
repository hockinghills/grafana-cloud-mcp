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

1. Create a KV namespace for OAuth (if using OAuth):
   ```bash
   wrangler kv namespace create OAUTH_KV
   ```

2. Set your Grafana Cloud credentials as secrets:
   ```bash
   wrangler secret put GRAFANA_CLOUD_URL
   # Enter your Grafana Cloud URL (e.g., https://myorg.grafana.net)

   wrangler secret put GRAFANA_SERVICE_ACCOUNT_TOKEN
   # Enter your service account token
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

### Connecting from Claude Desktop

Add to your Claude Desktop config (`~/.config/claude-code/settings.json` or similar):

```json
{
  "mcpServers": {
    "grafana-cloud": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-worker.your-subdomain.workers.dev/sse"
      ]
    }
  }
}
```

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

- Service account tokens are stored as Cloudflare Worker secrets (encrypted at rest)
- All API communication uses HTTPS
- The MCP server only exposes operations you've granted permissions for

## License

MIT
