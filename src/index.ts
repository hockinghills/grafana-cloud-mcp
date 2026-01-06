/**
 * Grafana Cloud MCP Server
 * A Cloudflare Workers-based MCP server for managing Grafana Cloud
 * Supports OAuth authentication for Claude web and mcp-remote clients
 * @module grafana-cloud-mcp
 */

import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { GrafanaClient } from './grafana-client';
import {
  GrafanaOAuthHandler,
  type GrafanaProps,
} from './grafana-oauth-handler';

// Environment bindings type
export interface Env {
  OAUTH_KV: KVNamespace;
  COOKIE_ENCRYPTION_KEY: string;
  ALLOWED_ORIGIN?: string;
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
 * Credentials are provided via OAuth flow (stored in this.props)
 */
export class GrafanaCloudMCP extends McpAgent<
  Env,
  Record<string, never>,
  GrafanaProps
> {
  server = new McpServer({
    name: 'grafana-cloud-mcp',
    version: '1.0.0',
  });

  private _client?: GrafanaClient;

  private getClient(): GrafanaClient {
    if (!this._client) {
      // Use credentials from OAuth props
      if (!this.props?.grafanaUrl || !this.props?.grafanaToken) {
        throw new Error('Grafana credentials not available - OAuth required');
      }
      this._client = new GrafanaClient({
        baseUrl: this.props.grafanaUrl,
        token: this.props.grafanaToken,
      });
    }
    return this._client;
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

        const status = {
          health: healthResult.data,
          user: userResult.success ? userResult.data : null,
          grafanaUrl: this.props?.grafanaUrl,
        };
        return toolResponse(`Grafana Cloud Status:\n${formatJson(status)}`);
      },
    );

    // ==================== Dashboard Tools ====================

    this.server.tool(
      'grafana_list_dashboards',
      'List all dashboards in Grafana Cloud with optional filtering',
      {
        query: z
          .string()
          .optional()
          .describe('Search query to filter dashboards by title'),
        folder_uid: z
          .string()
          .optional()
          .describe('Filter dashboards by folder UID'),
        tag: z
          .array(z.string())
          .optional()
          .describe('Filter dashboards by tags'),
        limit: z
          .number()
          .optional()
          .describe('Maximum number of dashboards to return'),
      },
      async ({ query, folder_uid, tag, limit }) => {
        // Use first tag only since API takes single tag
        const firstTag = tag && tag.length > 0 ? tag[0] : undefined;
        const result = await client.listDashboards(query, firstTag, folder_uid);

        if (!result.success) {
          return toolResponse(`Failed to list dashboards: ${result.error}`);
        }

        let dashboards = (result.data || []) as Array<{
          uid: string;
          title: string;
          folderTitle?: string;
          tags?: string[];
          url: string;
        }>;

        // Apply client-side limit if specified
        if (limit && dashboards.length > limit) {
          dashboards = dashboards.slice(0, limit);
        }

        if (dashboards.length === 0) {
          return toolResponse('No dashboards found matching the criteria.');
        }

        const summary = dashboards.map((d) => ({
          uid: d.uid,
          title: d.title,
          folderTitle: d.folderTitle,
          tags: d.tags,
          url: d.url,
        }));

        return toolResponse(
          `Found ${dashboards.length} dashboard(s):\n${formatJson(summary)}`,
        );
      },
    );

    this.server.tool(
      'grafana_get_dashboard',
      'Get a dashboard by its UID with full panel details',
      {
        uid: z.string().describe('The UID of the dashboard to retrieve'),
      },
      async ({ uid }) => {
        const result = await client.getDashboard(uid);

        if (!result.success) {
          return toolResponse(`Failed to get dashboard: ${result.error}`);
        }

        return toolResponse(`Dashboard details:\n${formatJson(result.data)}`);
      },
    );

    this.server.tool(
      'grafana_create_dashboard',
      'Create a new dashboard in Grafana Cloud',
      {
        title: z.string().describe('Dashboard title'),
        folder_uid: z
          .string()
          .optional()
          .describe('UID of the folder to create the dashboard in'),
        tags: z.array(z.string()).optional().describe('Tags for the dashboard'),
        panels: z
          .array(
            z.object({
              type: z
                .string()
                .describe('Panel type (e.g., "timeseries", "stat", "gauge")'),
              title: z.string().describe('Panel title'),
              gridPos: z
                .object({
                  x: z.number(),
                  y: z.number(),
                  w: z.number(),
                  h: z.number(),
                })
                .describe('Panel position and size'),
              expr: z
                .string()
                .optional()
                .describe('PromQL/LogQL query expression'),
              datasource_uid: z
                .string()
                .optional()
                .describe('Data source UID to use'),
            }),
          )
          .optional()
          .describe('Panel definitions'),
      },
      async ({ title, folder_uid, tags, panels }) => {
        const dashboardPanels = panels?.map((panel, index) => ({
          id: index + 1,
          type: panel.type,
          title: panel.title,
          gridPos: panel.gridPos,
          targets: panel.expr
            ? [
                {
                  refId: 'A',
                  expr: panel.expr,
                  datasource: panel.datasource_uid
                    ? { uid: panel.datasource_uid }
                    : undefined,
                },
              ]
            : undefined,
        }));

        const result = await client.createDashboard(
          {
            title,
            tags: tags || [],
            panels: dashboardPanels || [],
            schemaVersion: 39,
          },
          folder_uid,
        );

        if (!result.success) {
          return toolResponse(`Failed to create dashboard: ${result.error}`);
        }

        return toolResponse(
          `Dashboard created successfully:\n${formatJson(result.data)}`,
        );
      },
    );

    this.server.tool(
      'grafana_update_dashboard',
      'Update an existing dashboard by UID',
      {
        uid: z.string().describe('UID of the dashboard to update'),
        title: z.string().optional().describe('New dashboard title'),
        tags: z
          .array(z.string())
          .optional()
          .describe('New tags (replaces existing)'),
        panels: z
          .array(
            z.object({
              id: z
                .number()
                .optional()
                .describe('Panel ID (for updating existing panels)'),
              type: z.string().describe('Panel type'),
              title: z.string().describe('Panel title'),
              gridPos: z.object({
                x: z.number(),
                y: z.number(),
                w: z.number(),
                h: z.number(),
              }),
              expr: z.string().optional().describe('PromQL/LogQL query'),
              datasource_uid: z.string().optional().describe('Data source UID'),
            }),
          )
          .optional()
          .describe('New panel definitions (replaces existing panels)'),
      },
      async ({ uid, title, tags, panels }) => {
        // First, fetch the existing dashboard
        const existing = await client.getDashboard(uid);
        if (!existing.success) {
          return toolResponse(`Failed to fetch dashboard: ${existing.error}`);
        }

        const dashboard = existing.data?.dashboard;
        if (!dashboard) {
          return toolResponse('Dashboard not found');
        }

        // Update fields
        if (title) dashboard.title = title;
        if (tags) dashboard.tags = tags;
        if (panels) {
          dashboard.panels = panels.map((panel, index) => ({
            id: panel.id ?? index + 1,
            type: panel.type,
            title: panel.title,
            gridPos: panel.gridPos,
            targets: panel.expr
              ? [
                  {
                    refId: 'A',
                    expr: panel.expr,
                    datasource: panel.datasource_uid
                      ? { uid: panel.datasource_uid }
                      : undefined,
                  },
                ]
              : undefined,
          }));
        }

        // Save with incremented version
        // Note: This is a non-atomic read-modify-write operation.
        // In a concurrent environment, another update could occur between
        // our read and write, causing a version conflict.
        const result = await client.updateDashboard(dashboard);

        if (!result.success) {
          return toolResponse(`Failed to update dashboard: ${result.error}`);
        }

        return toolResponse(
          `Dashboard updated successfully:\n${formatJson(result.data)}`,
        );
      },
    );

    this.server.tool(
      'grafana_delete_dashboard',
      'Delete a dashboard by its UID',
      {
        uid: z.string().describe('UID of the dashboard to delete'),
      },
      async ({ uid }) => {
        const result = await client.deleteDashboard(uid);

        if (!result.success) {
          return toolResponse(`Failed to delete dashboard: ${result.error}`);
        }

        const details = result.data ? `:\n${formatJson(result.data)}` : '';
        return toolResponse(`Dashboard deleted successfully${details}`);
      },
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

        const sources = result.data || [];
        const summary = sources.map((ds) => ({
          uid: ds.uid,
          name: ds.name,
          type: ds.type,
          isDefault: ds.isDefault,
        }));

        return toolResponse(
          `Found ${sources.length} data source(s):\n${formatJson(summary)}`,
        );
      },
    );

    this.server.tool(
      'grafana_get_datasource',
      'Get details of a specific data source by UID',
      {
        uid: z.string().describe('UID of the data source'),
      },
      async ({ uid }) => {
        const result = await client.getDataSource(uid);

        if (!result.success) {
          return toolResponse(`Failed to get data source: ${result.error}`);
        }

        return toolResponse(`Data source details:\n${formatJson(result.data)}`);
      },
    );

    this.server.tool(
      'grafana_create_datasource',
      'Create a new data source in Grafana Cloud',
      {
        name: z.string().describe('Name of the data source'),
        type: z
          .string()
          .describe('Type (e.g., "prometheus", "loki", "elasticsearch")'),
        url: z.string().describe('URL of the data source'),
        access: z
          .enum(['proxy', 'direct'])
          .optional()
          .describe('Access mode (default: proxy)'),
        is_default: z
          .boolean()
          .optional()
          .describe('Set as default data source'),
        basic_auth: z
          .boolean()
          .optional()
          .describe('Enable basic authentication'),
        json_data: z
          .record(z.unknown())
          .optional()
          .describe('Additional JSON configuration'),
      },
      async ({
        name,
        type,
        url,
        access,
        is_default,
        basic_auth,
        json_data,
      }) => {
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

        return toolResponse(
          `Data source created successfully:\n${formatJson(result.data)}`,
        );
      },
    );

    this.server.tool(
      'grafana_delete_datasource',
      'Delete a data source by UID',
      {
        uid: z.string().describe('UID of the data source to delete'),
      },
      async ({ uid }) => {
        const result = await client.deleteDataSource(uid);

        if (!result.success) {
          return toolResponse(`Failed to delete data source: ${result.error}`);
        }

        const details = result.data ? `:\n${formatJson(result.data)}` : '';
        return toolResponse(`Data source deleted successfully${details}`);
      },
    );

    this.server.tool(
      'grafana_test_datasource',
      'Test a data source connection',
      {
        uid: z.string().describe('UID of the data source to test'),
      },
      async ({ uid }) => {
        const result = await client.testDataSource(uid);

        if (!result.success) {
          return toolResponse(`Data source test failed: ${result.error}`);
        }

        return toolResponse(
          `Data source test result:\n${formatJson(result.data)}`,
        );
      },
    );

    // ==================== Alert Rule Tools ====================

    this.server.tool(
      'grafana_list_alert_rules',
      'List all alert rules in Grafana Cloud',
      {},
      async () => {
        const result = await client.listAlertRules();

        if (!result.success) {
          return toolResponse(`Failed to list alert rules: ${result.error}`);
        }

        const rules = result.data || [];
        return toolResponse(
          `Found ${rules.length} alert rule(s):\n${formatJson(rules)}`,
        );
      },
    );

    this.server.tool(
      'grafana_get_alert_rule',
      'Get details of a specific alert rule',
      {
        uid: z.string().describe('UID of the alert rule'),
      },
      async ({ uid }) => {
        const result = await client.getAlertRule(uid);

        if (!result.success) {
          return toolResponse(`Failed to get alert rule: ${result.error}`);
        }

        return toolResponse(`Alert rule details:\n${formatJson(result.data)}`);
      },
    );

    this.server.tool(
      'grafana_create_alert_rule',
      'Create a new alert rule in Grafana Cloud',
      {
        title: z.string().describe('Alert rule title'),
        folder_uid: z.string().describe('UID of the folder for this alert'),
        rule_group: z.string().describe('Name of the rule group'),
        condition: z
          .string()
          .describe('Condition refId (e.g., "C" for the condition expression)'),
        for_duration: z
          .string()
          .optional()
          .describe('Duration before firing (e.g., "5m", "1h")'),
        datasource_uid: z.string().describe('UID of the data source to query'),
        query_expr: z
          .string()
          .describe('Query expression (PromQL, LogQL, etc.)'),
        query_time_range_seconds: z
          .number()
          .optional()
          .describe(
            'Time range in seconds for the query lookback window (default: 600 = 10 minutes)',
          ),
        threshold_value: z.number().describe('Threshold value for the alert'),
        threshold_operator: z
          .enum(['gt', 'lt', 'gte', 'lte', 'eq', 'neq'])
          .describe('Threshold comparison operator'),
        labels: z
          .record(z.string())
          .optional()
          .describe('Labels to add to the alert'),
        annotations: z
          .record(z.string())
          .optional()
          .describe('Annotations (summary, description, runbook_url)'),
      },
      async ({
        title,
        folder_uid,
        rule_group,
        condition,
        for_duration,
        datasource_uid,
        query_expr,
        query_time_range_seconds,
        threshold_value,
        threshold_operator,
        labels,
        annotations,
      }) => {
        // Build the alert rule with query and condition
        const timeRangeSeconds = query_time_range_seconds ?? 600;
        const conditionRef = condition || 'C';
        const rule = {
          title,
          folderUID: folder_uid,
          ruleGroup: rule_group,
          condition: conditionRef,
          for: for_duration || '5m',
          labels: labels || {},
          annotations: annotations || {},
          noDataState: 'NoData' as const,
          execErrState: 'Error' as const,
          data: [
            {
              refId: 'A',
              queryType: '',
              relativeTimeRange: { from: timeRangeSeconds, to: 0 },
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
              refId: conditionRef,
              queryType: '',
              relativeTimeRange: { from: 0, to: 0 },
              datasourceUid: '__expr__',
              model: {
                type: 'threshold',
                expression: 'B',
                refId: conditionRef,
                conditions: [
                  {
                    type: 'query',
                    evaluator: {
                      type: threshold_operator,
                      params: [threshold_value],
                    },
                  },
                ],
              },
            },
          ],
        };

        const result = await client.createAlertRule(rule);

        if (!result.success) {
          return toolResponse(`Failed to create alert rule: ${result.error}`);
        }

        return toolResponse(
          `Alert rule created successfully:\n${formatJson(result.data)}`,
        );
      },
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
      },
    );

    // ==================== Contact Point Tools ====================

    this.server.tool(
      'grafana_list_contact_points',
      'List all notification contact points',
      {},
      async () => {
        const result = await client.listContactPoints();

        if (!result.success) {
          return toolResponse(`Failed to list contact points: ${result.error}`);
        }

        const contacts = result.data || [];
        return toolResponse(
          `Found ${contacts.length} contact point(s):\n${formatJson(contacts)}`,
        );
      },
    );

    this.server.tool(
      'grafana_create_contact_point',
      'Create a new notification contact point',
      {
        name: z.string().describe('Name of the contact point'),
        type: z
          .string()
          .describe(
            'Type (e.g., "email", "slack", "pagerduty", "webhook", "teams")',
          ),
        settings: z
          .record(z.unknown())
          .describe(
            'Type-specific settings (e.g., { "addresses": "user@example.com" } for email)',
          ),
        disable_resolve_message: z
          .boolean()
          .optional()
          .describe('Disable sending resolved notifications'),
      },
      async ({ name, type, settings, disable_resolve_message }) => {
        const result = await client.createContactPoint({
          name,
          type,
          settings,
          disableResolveMessage: disable_resolve_message,
        });

        if (!result.success) {
          return toolResponse(
            `Failed to create contact point: ${result.error}`,
          );
        }

        return toolResponse(
          `Contact point created successfully:\n${formatJson(result.data)}`,
        );
      },
    );

    this.server.tool(
      'grafana_delete_contact_point',
      'Delete a notification contact point',
      {
        uid: z.string().describe('UID of the contact point to delete'),
      },
      async ({ uid }) => {
        const result = await client.deleteContactPoint(uid);

        if (!result.success) {
          return toolResponse(
            `Failed to delete contact point: ${result.error}`,
          );
        }

        return toolResponse('Contact point deleted successfully');
      },
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

        const folders = result.data || [];
        const summary = folders.map((f) => ({
          uid: f.uid,
          title: f.title,
          parentUid: f.parentUid,
        }));

        return toolResponse(
          `Found ${folders.length} folder(s):\n${formatJson(summary)}`,
        );
      },
    );

    this.server.tool(
      'grafana_create_folder',
      'Create a new folder in Grafana Cloud',
      {
        title: z.string().describe('Folder title'),
        parent_uid: z
          .string()
          .optional()
          .describe('UID of the parent folder (for nested folders)'),
      },
      async ({ title, parent_uid }) => {
        const result = await client.createFolder({
          title,
          parentUid: parent_uid,
        });

        if (!result.success) {
          return toolResponse(`Failed to create folder: ${result.error}`);
        }

        return toolResponse(
          `Folder created successfully:\n${formatJson(result.data)}`,
        );
      },
    );

    this.server.tool(
      'grafana_delete_folder',
      'Delete a folder from Grafana Cloud',
      {
        uid: z.string().describe('UID of the folder to delete'),
      },
      async ({ uid }) => {
        const result = await client.deleteFolder(uid);

        if (!result.success) {
          return toolResponse(`Failed to delete folder: ${result.error}`);
        }

        const details = result.data ? `:\n${formatJson(result.data)}` : '';
        return toolResponse(`Folder deleted successfully${details}`);
      },
    );

    // ==================== Annotation Tools ====================

    this.server.tool(
      'grafana_list_annotations',
      'List annotations with optional filters',
      {
        from: z
          .number()
          .optional()
          .describe('Start time in epoch milliseconds'),
        to: z.number().optional().describe('End time in epoch milliseconds'),
        dashboard_uid: z
          .string()
          .optional()
          .describe('Filter by dashboard UID'),
        panel_id: z.number().optional().describe('Filter by panel ID'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
        limit: z.number().optional().describe('Maximum number of annotations'),
      },
      async ({ from, to, dashboard_uid, panel_id, tags, limit }) => {
        const result = await client.listAnnotations(
          dashboard_uid,
          from,
          to,
          limit,
          panel_id,
          tags,
        );

        if (!result.success) {
          return toolResponse(`Failed to list annotations: ${result.error}`);
        }

        const annotations = result.data || [];
        return toolResponse(
          `Found ${annotations.length} annotation(s):\n${formatJson(annotations)}`,
        );
      },
    );

    this.server.tool(
      'grafana_create_annotation',
      'Create a new annotation',
      {
        text: z.string().describe('Annotation text content'),
        time: z
          .number()
          .optional()
          .describe('Time in epoch milliseconds (default: now)'),
        time_end: z
          .number()
          .optional()
          .describe('End time for region annotation'),
        dashboard_uid: z
          .string()
          .optional()
          .describe('Associate with dashboard'),
        panel_id: z.number().optional().describe('Associate with panel'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tags for the annotation'),
      },
      async ({ text, time, time_end, dashboard_uid, panel_id, tags }) => {
        const result = await client.createAnnotation({
          text,
          time: time ?? Date.now(),
          timeEnd: time_end,
          dashboardUID: dashboard_uid,
          panelId: panel_id,
          tags,
        });

        if (!result.success) {
          return toolResponse(`Failed to create annotation: ${result.error}`);
        }

        return toolResponse(
          `Annotation created successfully:\n${formatJson(result.data)}`,
        );
      },
    );

    this.server.tool(
      'grafana_delete_annotation',
      'Delete an annotation by ID',
      {
        id: z.number().describe('ID of the annotation to delete'),
      },
      async ({ id }) => {
        const result = await client.deleteAnnotation(id);

        if (!result.success) {
          return toolResponse(`Failed to delete annotation: ${result.error}`);
        }

        const details = result.data ? `:\n${formatJson(result.data)}` : '';
        return toolResponse(`Annotation deleted successfully${details}`);
      },
    );

    // ==================== Query Tool ====================

    this.server.tool(
      'grafana_query_metrics',
      'Execute a metrics query against a Grafana data source',
      {
        datasource_uid: z.string().describe('UID of the data source to query'),
        expr: z.string().describe('Query expression (PromQL, LogQL, etc.)'),
        from: z
          .number()
          .optional()
          .describe('Start time in epoch milliseconds (default: 1 hour ago)'),
        to: z
          .number()
          .optional()
          .describe('End time in epoch milliseconds (default: now)'),
        instant: z
          .boolean()
          .optional()
          .describe('Execute as instant query (default: false)'),
      },
      async ({ datasource_uid, expr, from, to, instant }) => {
        const now = Date.now();
        const result = await client.queryMetrics(
          [
            {
              refId: 'A',
              datasourceUid: datasource_uid,
              expr,
              instant,
            },
          ],
          from ?? now - 3600000, // 1 hour ago
          to ?? now,
        );

        if (!result.success) {
          return toolResponse(`Query failed: ${result.error}`);
        }

        return toolResponse(`Query results:\n${formatJson(result.data)}`);
      },
    );
  }
}

// Export OAuthProvider as the default handler
// This wraps our MCP server with OAuth authentication
export default new OAuthProvider({
  apiHandlers: {
    '/sse': GrafanaCloudMCP.serveSSE('/sse'),
    '/mcp': GrafanaCloudMCP.serve('/mcp'),
  },
  // Hono apps are compatible with ExportedHandler - cast to satisfy type checker
  // biome-ignore lint/suspicious/noExplicitAny: Required for Hono/OAuthProvider type compatibility
  defaultHandler: GrafanaOAuthHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
});
