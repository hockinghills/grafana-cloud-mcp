/**
 * Grafana Cloud MCP Server
 * A Cloudflare Workers-based MCP server for managing Grafana Cloud
 */

import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GrafanaClient } from './grafana-client';

// Environment bindings type
export interface Env {
  GRAFANA_CLOUD_URL: string;
  GRAFANA_SERVICE_ACCOUNT_TOKEN: string;
  MCP_OBJECT: DurableObjectNamespace;
}

// Tool response helper
function toolResponse(content: string) {
  return { content: [{ type: 'text' as const, text: content }] };
}

function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Grafana Cloud MCP Server
 * Provides tools for managing dashboards, alerts, data sources, and more
 */
export class GrafanaCloudMCP extends McpAgent<Env> {
  server = new McpServer({
    name: 'grafana-cloud-mcp',
    version: '1.0.0',
  });

  private getClient(): GrafanaClient {
    return new GrafanaClient({
      baseUrl: this.env.GRAFANA_CLOUD_URL,
      token: this.env.GRAFANA_SERVICE_ACCOUNT_TOKEN,
    });
  }

  async init() {
    const client = this.getClient();

    // ==================== Health & Info Tools ====================

    this.server.tool(
      'grafana_health_check',
      'Check the health status of the Grafana Cloud instance and verify authentication',
      {},
      async () => {
        const [healthResult, userResult] = await Promise.all([
          client.healthCheck(),
          client.getCurrentUser(),
        ]);

        if (!healthResult.success) {
          return toolResponse(`Health check failed: ${healthResult.error}`);
        }

        let response = `Grafana Health Status:\n${formatJson(healthResult.data)}`;

        if (userResult.success) {
          response += `\n\nAuthenticated as:\n${formatJson(userResult.data)}`;
        }

        return toolResponse(response);
      }
    );

    // ==================== Dashboard Tools ====================

    this.server.tool(
      'grafana_list_dashboards',
      'List all dashboards in Grafana Cloud. Optionally filter by query, tag, or folder.',
      {
        query: z.string().optional().describe('Search query to filter dashboards by title'),
        tag: z.string().optional().describe('Filter dashboards by tag'),
        folder_uid: z.string().optional().describe('Filter dashboards by folder UID'),
      },
      async ({ query, tag, folder_uid }) => {
        const result = await client.listDashboards(query, tag, folder_uid);

        if (!result.success) {
          return toolResponse(`Failed to list dashboards: ${result.error}`);
        }

        return toolResponse(`Found ${(result.data as unknown[]).length} dashboards:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_get_dashboard',
      'Get a specific dashboard by its UID, including all panels and configuration',
      {
        uid: z.string().describe('The unique identifier (UID) of the dashboard'),
      },
      async ({ uid }) => {
        const result = await client.getDashboard(uid);

        if (!result.success) {
          return toolResponse(`Failed to get dashboard: ${result.error}`);
        }

        return toolResponse(`Dashboard details:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_create_dashboard',
      'Create a new dashboard in Grafana Cloud',
      {
        title: z.string().describe('Dashboard title'),
        folder_uid: z.string().optional().describe('UID of the folder to place the dashboard in'),
        tags: z.array(z.string()).optional().describe('Tags to apply to the dashboard'),
        panels: z.array(z.object({
          type: z.string().describe('Panel type (e.g., timeseries, stat, gauge, table, logs)'),
          title: z.string().describe('Panel title'),
          gridPos: z.object({
            x: z.number().describe('X position (0-23)'),
            y: z.number().describe('Y position'),
            w: z.number().describe('Width (1-24)'),
            h: z.number().describe('Height'),
          }).describe('Panel grid position'),
          datasource_uid: z.string().optional().describe('Data source UID'),
          expr: z.string().optional().describe('Query expression (PromQL for Prometheus, LogQL for Loki, etc.)'),
        })).optional().describe('Array of panels to add to the dashboard'),
      },
      async ({ title, folder_uid, tags, panels }) => {
        const dashboardPanels = panels?.map((panel, index) => ({
          id: index + 1,
          type: panel.type,
          title: panel.title,
          gridPos: panel.gridPos,
          targets: panel.expr ? [{
            refId: 'A',
            expr: panel.expr,
            datasource: panel.datasource_uid ? { uid: panel.datasource_uid } : undefined,
          }] : undefined,
        }));

        const result = await client.createDashboard(
          {
            title,
            tags,
            panels: dashboardPanels || [],
            schemaVersion: 39,
            timezone: 'browser',
          },
          folder_uid
        );

        if (!result.success) {
          return toolResponse(`Failed to create dashboard: ${result.error}`);
        }

        return toolResponse(`Dashboard created successfully:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_update_dashboard',
      'Update an existing dashboard. Fetches current dashboard, applies changes, and saves.',
      {
        uid: z.string().describe('UID of the dashboard to update'),
        title: z.string().optional().describe('New dashboard title'),
        tags: z.array(z.string()).optional().describe('New tags (replaces existing)'),
        add_panel: z.object({
          type: z.string().describe('Panel type'),
          title: z.string().describe('Panel title'),
          gridPos: z.object({
            x: z.number(),
            y: z.number(),
            w: z.number(),
            h: z.number(),
          }),
          datasource_uid: z.string().optional(),
          expr: z.string().optional(),
        }).optional().describe('Add a new panel to the dashboard'),
      },
      async ({ uid, title, tags, add_panel }) => {
        // First, get the current dashboard
        const getResult = await client.getDashboard(uid);
        if (!getResult.success) {
          return toolResponse(`Failed to get dashboard: ${getResult.error}`);
        }

        const dashboard = getResult.data!.dashboard;

        // Apply updates
        if (title) dashboard.title = title;
        if (tags) dashboard.tags = tags;

        if (add_panel) {
          const panels = dashboard.panels || [];
          const maxId = panels.reduce((max, p) => Math.max(max, p.id || 0), 0);
          panels.push({
            id: maxId + 1,
            type: add_panel.type,
            title: add_panel.title,
            gridPos: add_panel.gridPos,
            targets: add_panel.expr ? [{
              refId: 'A',
              expr: add_panel.expr,
              datasource: add_panel.datasource_uid ? { uid: add_panel.datasource_uid } : undefined,
            }] : undefined,
          });
          dashboard.panels = panels;
        }

        const result = await client.updateDashboard(dashboard);

        if (!result.success) {
          return toolResponse(`Failed to update dashboard: ${result.error}`);
        }

        return toolResponse(`Dashboard updated successfully:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_delete_dashboard',
      'Delete a dashboard from Grafana Cloud',
      {
        uid: z.string().describe('UID of the dashboard to delete'),
      },
      async ({ uid }) => {
        const result = await client.deleteDashboard(uid);

        if (!result.success) {
          return toolResponse(`Failed to delete dashboard: ${result.error}`);
        }

        return toolResponse(`Dashboard deleted successfully:\n${formatJson(result.data)}`);
      }
    );

    // ==================== Data Source Tools ====================

    this.server.tool(
      'grafana_list_datasources',
      'List all configured data sources in Grafana Cloud',
      {},
      async () => {
        const result = await client.listDataSources();

        if (!result.success) {
          return toolResponse(`Failed to list data sources: ${result.error}`);
        }

        const summary = result.data?.map(ds => ({
          uid: ds.uid,
          name: ds.name,
          type: ds.type,
          isDefault: ds.isDefault,
        }));

        return toolResponse(`Found ${result.data?.length || 0} data sources:\n${formatJson(summary)}`);
      }
    );

    this.server.tool(
      'grafana_get_datasource',
      'Get detailed information about a specific data source',
      {
        uid: z.string().describe('UID of the data source'),
      },
      async ({ uid }) => {
        const result = await client.getDataSource(uid);

        if (!result.success) {
          return toolResponse(`Failed to get data source: ${result.error}`);
        }

        return toolResponse(`Data source details:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_create_datasource',
      'Create a new data source in Grafana Cloud',
      {
        name: z.string().describe('Name for the data source'),
        type: z.string().describe('Data source type (e.g., prometheus, loki, elasticsearch, influxdb, mysql, postgres)'),
        url: z.string().optional().describe('URL of the data source'),
        access: z.enum(['proxy', 'direct']).optional().describe('Access mode'),
        is_default: z.boolean().optional().describe('Set as default data source'),
        basic_auth: z.boolean().optional().describe('Enable basic authentication'),
        json_data: z.record(z.unknown()).optional().describe('Additional JSON configuration'),
      },
      async ({ name, type, url, access, is_default, basic_auth, json_data }) => {
        const result = await client.createDataSource({
          name,
          type,
          url,
          access: access || 'proxy',
          isDefault: is_default,
          basicAuth: basic_auth,
          jsonData: json_data,
        });

        if (!result.success) {
          return toolResponse(`Failed to create data source: ${result.error}`);
        }

        return toolResponse(`Data source created successfully:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_delete_datasource',
      'Delete a data source from Grafana Cloud',
      {
        uid: z.string().describe('UID of the data source to delete'),
      },
      async ({ uid }) => {
        const result = await client.deleteDataSource(uid);

        if (!result.success) {
          return toolResponse(`Failed to delete data source: ${result.error}`);
        }

        return toolResponse(`Data source deleted successfully:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_test_datasource',
      'Test the connection and health of a data source',
      {
        uid: z.string().describe('UID of the data source to test'),
      },
      async ({ uid }) => {
        const result = await client.testDataSource(uid);

        if (!result.success) {
          return toolResponse(`Data source test failed: ${result.error}`);
        }

        return toolResponse(`Data source test result:\n${formatJson(result.data)}`);
      }
    );

    // ==================== Alert Rule Tools ====================

    this.server.tool(
      'grafana_list_alert_rules',
      'List all alert rules configured in Grafana Cloud',
      {},
      async () => {
        const result = await client.listAlertRules();

        if (!result.success) {
          return toolResponse(`Failed to list alert rules: ${result.error}`);
        }

        const summary = result.data?.map(rule => ({
          uid: rule.uid,
          title: rule.title,
          folderUID: rule.folderUID,
          ruleGroup: rule.ruleGroup,
          isPaused: rule.isPaused,
        }));

        return toolResponse(`Found ${result.data?.length || 0} alert rules:\n${formatJson(summary)}`);
      }
    );

    this.server.tool(
      'grafana_get_alert_rule',
      'Get detailed information about a specific alert rule',
      {
        uid: z.string().describe('UID of the alert rule'),
      },
      async ({ uid }) => {
        const result = await client.getAlertRule(uid);

        if (!result.success) {
          return toolResponse(`Failed to get alert rule: ${result.error}`);
        }

        return toolResponse(`Alert rule details:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_create_alert_rule',
      'Create a new alert rule in Grafana Cloud',
      {
        title: z.string().describe('Alert rule title'),
        folder_uid: z.string().describe('UID of the folder for this alert'),
        rule_group: z.string().describe('Name of the rule group'),
        condition: z.string().describe('Condition refId (e.g., "C" for the condition expression)'),
        for_duration: z.string().optional().describe('Duration before firing (e.g., "5m", "1h")'),
        datasource_uid: z.string().describe('UID of the data source to query'),
        query_expr: z.string().describe('Query expression (PromQL, LogQL, etc.)'),
        threshold_value: z.number().describe('Threshold value for the alert'),
        threshold_operator: z.enum(['gt', 'lt', 'gte', 'lte', 'eq', 'neq']).describe('Threshold comparison operator'),
        labels: z.record(z.string()).optional().describe('Labels to add to the alert'),
        annotations: z.record(z.string()).optional().describe('Annotations (summary, description, runbook_url)'),
      },
      async ({ title, folder_uid, rule_group, condition, for_duration, datasource_uid, query_expr, threshold_value, threshold_operator, labels, annotations }) => {
        // Build the alert rule with query and condition
        const rule = {
          title,
          folderUID: folder_uid,
          ruleGroup: rule_group,
          condition: condition || 'C',
          for: for_duration || '5m',
          labels: labels || {},
          annotations: annotations || {},
          noDataState: 'NoData' as const,
          execErrState: 'Error' as const,
          data: [
            {
              refId: 'A',
              queryType: '',
              relativeTimeRange: { from: 600, to: 0 },
              datasourceUid: datasource_uid,
              model: {
                expr: query_expr,
                refId: 'A',
              },
            },
            {
              refId: 'B',
              queryType: '',
              relativeTimeRange: { from: 0, to: 0 },
              datasourceUid: '__expr__',
              model: {
                type: 'reduce',
                expression: 'A',
                reducer: 'last',
                refId: 'B',
              },
            },
            {
              refId: 'C',
              queryType: '',
              relativeTimeRange: { from: 0, to: 0 },
              datasourceUid: '__expr__',
              model: {
                type: 'threshold',
                expression: 'B',
                refId: 'C',
                conditions: [{
                  type: 'query',
                  evaluator: {
                    type: threshold_operator,
                    params: [threshold_value],
                  },
                }],
              },
            },
          ],
        };

        const result = await client.createAlertRule(rule);

        if (!result.success) {
          return toolResponse(`Failed to create alert rule: ${result.error}`);
        }

        return toolResponse(`Alert rule created successfully:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_delete_alert_rule',
      'Delete an alert rule from Grafana Cloud',
      {
        uid: z.string().describe('UID of the alert rule to delete'),
      },
      async ({ uid }) => {
        const result = await client.deleteAlertRule(uid);

        if (!result.success) {
          return toolResponse(`Failed to delete alert rule: ${result.error}`);
        }

        return toolResponse('Alert rule deleted successfully');
      }
    );

    // ==================== Contact Point Tools ====================

    this.server.tool(
      'grafana_list_contact_points',
      'List all alert notification contact points',
      {},
      async () => {
        const result = await client.listContactPoints();

        if (!result.success) {
          return toolResponse(`Failed to list contact points: ${result.error}`);
        }

        return toolResponse(`Found ${result.data?.length || 0} contact points:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_create_contact_point',
      'Create a new alert notification contact point',
      {
        name: z.string().describe('Name for the contact point'),
        type: z.enum(['email', 'slack', 'pagerduty', 'webhook', 'teams', 'discord', 'opsgenie', 'victorops'])
          .describe('Type of contact point'),
        settings: z.record(z.unknown()).describe('Contact point settings (varies by type)'),
        disable_resolve_message: z.boolean().optional().describe('Disable sending resolve messages'),
      },
      async ({ name, type, settings, disable_resolve_message }) => {
        const result = await client.createContactPoint({
          name,
          type,
          settings,
          disableResolveMessage: disable_resolve_message,
        });

        if (!result.success) {
          return toolResponse(`Failed to create contact point: ${result.error}`);
        }

        return toolResponse(`Contact point created successfully:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_delete_contact_point',
      'Delete an alert notification contact point',
      {
        uid: z.string().describe('UID of the contact point to delete'),
      },
      async ({ uid }) => {
        const result = await client.deleteContactPoint(uid);

        if (!result.success) {
          return toolResponse(`Failed to delete contact point: ${result.error}`);
        }

        return toolResponse('Contact point deleted successfully');
      }
    );

    // ==================== Folder Tools ====================

    this.server.tool(
      'grafana_list_folders',
      'List all folders in Grafana Cloud',
      {},
      async () => {
        const result = await client.listFolders();

        if (!result.success) {
          return toolResponse(`Failed to list folders: ${result.error}`);
        }

        return toolResponse(`Found ${result.data?.length || 0} folders:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_create_folder',
      'Create a new folder for organizing dashboards and alerts',
      {
        title: z.string().describe('Folder title'),
        parent_uid: z.string().optional().describe('UID of parent folder (for nested folders)'),
      },
      async ({ title, parent_uid }) => {
        const result = await client.createFolder({
          title,
          parentUid: parent_uid,
        });

        if (!result.success) {
          return toolResponse(`Failed to create folder: ${result.error}`);
        }

        return toolResponse(`Folder created successfully:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_delete_folder',
      'Delete a folder (and optionally its contents)',
      {
        uid: z.string().describe('UID of the folder to delete'),
      },
      async ({ uid }) => {
        const result = await client.deleteFolder(uid);

        if (!result.success) {
          return toolResponse(`Failed to delete folder: ${result.error}`);
        }

        return toolResponse(`Folder deleted successfully:\n${formatJson(result.data)}`);
      }
    );

    // ==================== Annotation Tools ====================

    this.server.tool(
      'grafana_list_annotations',
      'List annotations, optionally filtered by dashboard',
      {
        dashboard_uid: z.string().optional().describe('Filter by dashboard UID'),
        from: z.number().optional().describe('Start time (Unix timestamp in ms)'),
        to: z.number().optional().describe('End time (Unix timestamp in ms)'),
        limit: z.number().optional().describe('Maximum number of annotations to return'),
      },
      async ({ dashboard_uid, from, to, limit }) => {
        const result = await client.listAnnotations(dashboard_uid, from, to, limit);

        if (!result.success) {
          return toolResponse(`Failed to list annotations: ${result.error}`);
        }

        return toolResponse(`Found ${(result.data as unknown[]).length} annotations:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_create_annotation',
      'Create an annotation on a dashboard to mark important events',
      {
        text: z.string().describe('Annotation text/description'),
        dashboard_uid: z.string().optional().describe('Dashboard UID to attach annotation to'),
        panel_id: z.number().optional().describe('Panel ID within the dashboard'),
        time: z.number().optional().describe('Annotation time (Unix timestamp in ms, defaults to now)'),
        time_end: z.number().optional().describe('End time for range annotation'),
        tags: z.array(z.string()).optional().describe('Tags for the annotation'),
      },
      async ({ text, dashboard_uid, panel_id, time, time_end, tags }) => {
        const result = await client.createAnnotation({
          text,
          dashboardUID: dashboard_uid,
          panelId: panel_id,
          time: time || Date.now(),
          timeEnd: time_end,
          tags,
        });

        if (!result.success) {
          return toolResponse(`Failed to create annotation: ${result.error}`);
        }

        return toolResponse(`Annotation created successfully:\n${formatJson(result.data)}`);
      }
    );

    this.server.tool(
      'grafana_delete_annotation',
      'Delete an annotation',
      {
        id: z.number().describe('ID of the annotation to delete'),
      },
      async ({ id }) => {
        const result = await client.deleteAnnotation(id);

        if (!result.success) {
          return toolResponse(`Failed to delete annotation: ${result.error}`);
        }

        return toolResponse(`Annotation deleted successfully:\n${formatJson(result.data)}`);
      }
    );

    // ==================== Query Tool ====================

    this.server.tool(
      'grafana_query_metrics',
      'Execute a query against a data source to retrieve metrics data',
      {
        datasource_uid: z.string().describe('UID of the data source to query'),
        expr: z.string().describe('Query expression (PromQL for Prometheus, LogQL for Loki, etc.)'),
        from: z.number().optional().describe('Start time (Unix timestamp in ms, defaults to 1 hour ago)'),
        to: z.number().optional().describe('End time (Unix timestamp in ms, defaults to now)'),
        instant: z.boolean().optional().describe('Execute as instant query (point in time)'),
      },
      async ({ datasource_uid, expr, from, to, instant }) => {
        const now = Date.now();
        const result = await client.queryMetrics(
          [{
            datasourceUid: datasource_uid,
            expr,
            refId: 'A',
            instant: instant || false,
            range: !instant,
          }],
          from || now - 3600000,
          to || now
        );

        if (!result.success) {
          return toolResponse(`Failed to query metrics: ${result.error}`);
        }

        return toolResponse(`Query results:\n${formatJson(result.data)}`);
      }
    );
  }
}

// Worker export
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Simple SSE endpoint for MCP
    if (url.pathname === '/sse' || url.pathname === '/mcp') {
      const id = env.MCP_OBJECT.idFromName('grafana-cloud-mcp');
      const stub = env.MCP_OBJECT.get(id);
      return stub.fetch(request);
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', server: 'grafana-cloud-mcp' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Root endpoint with info
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        name: 'Grafana Cloud MCP Server',
        version: '1.0.0',
        description: 'MCP server for managing Grafana Cloud dashboards, alerts, data sources, and more',
        endpoints: {
          mcp: '/sse or /mcp',
          health: '/health',
        },
        tools: [
          'grafana_health_check',
          'grafana_list_dashboards',
          'grafana_get_dashboard',
          'grafana_create_dashboard',
          'grafana_update_dashboard',
          'grafana_delete_dashboard',
          'grafana_list_datasources',
          'grafana_get_datasource',
          'grafana_create_datasource',
          'grafana_delete_datasource',
          'grafana_test_datasource',
          'grafana_list_alert_rules',
          'grafana_get_alert_rule',
          'grafana_create_alert_rule',
          'grafana_delete_alert_rule',
          'grafana_list_contact_points',
          'grafana_create_contact_point',
          'grafana_delete_contact_point',
          'grafana_list_folders',
          'grafana_create_folder',
          'grafana_delete_folder',
          'grafana_list_annotations',
          'grafana_create_annotation',
          'grafana_delete_annotation',
          'grafana_query_metrics',
        ],
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
