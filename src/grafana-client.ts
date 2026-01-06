/**
 * Grafana Cloud API Client
 * Handles authentication and API calls to Grafana Cloud
 * @module grafana-client
 */

export interface GrafanaConfig {
  baseUrl: string;
  token: string;
}

export interface Dashboard {
  uid?: string;
  title: string;
  tags?: string[];
  timezone?: string;
  schemaVersion?: number;
  panels?: Panel[];
  templating?: { list: TemplateVariable[] };
  time?: { from: string; to: string };
  refresh?: string;
}

export interface Panel {
  id?: number;
  type: string;
  title: string;
  gridPos: { x: number; y: number; w: number; h: number };
  targets?: Target[];
  options?: Record<string, unknown>;
  fieldConfig?: Record<string, unknown>;
}

export interface Target {
  refId: string;
  expr?: string;
  legendFormat?: string;
  datasource?: { type?: string; uid: string };
}

export interface TemplateVariable {
  name: string;
  type: string;
  query?: string;
  datasource?: { type: string; uid: string };
  current?: { text: string; value: string };
  options?: { text: string; value: string }[];
}

export interface DataSource {
  id?: number;
  uid?: string;
  name: string;
  type: string;
  url?: string;
  access?: string;
  basicAuth?: boolean;
  isDefault?: boolean;
  jsonData?: Record<string, unknown>;
  secureJsonData?: Record<string, unknown>;
}

export interface AlertRule {
  uid?: string;
  title: string;
  condition: string;
  data: AlertQuery[];
  noDataState?: 'NoData' | 'Alerting' | 'OK';
  execErrState?: 'Error' | 'Alerting' | 'OK';
  for?: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  isPaused?: boolean;
  folderUID: string;
  ruleGroup: string;
}

export interface AlertQuery {
  refId: string;
  queryType?: string;
  relativeTimeRange: { from: number; to: number };
  datasourceUid: string;
  model: Record<string, unknown>;
}

export interface ContactPoint {
  uid?: string;
  name: string;
  type: string;
  settings: Record<string, unknown>;
  disableResolveMessage?: boolean;
}

export interface Folder {
  uid?: string;
  title: string;
  parentUid?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class GrafanaClient {
  private baseUrl: string;
  private token: string;

  constructor(config: GrafanaConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
  }

  /**
   * Sanitizes error messages to avoid leaking internal details.
   * Maps HTTP status codes to user-friendly messages.
   */
  private sanitizeError(status: number, _rawError: string): string {
    // Map common HTTP errors to user-friendly messages
    const statusMessages: Record<number, string> = {
      400: 'Bad request - please check your input parameters',
      401: 'Authentication failed - check your Grafana credentials',
      403: 'Access denied - insufficient permissions',
      404: 'Resource not found',
      409: 'Conflict - resource already exists or version mismatch',
      422: 'Invalid data - please check your input',
      429: 'Rate limited - please try again later',
      500: 'Grafana server error - please try again',
      502: 'Grafana gateway error - please try again',
      503: 'Grafana service unavailable - please try again',
    };

    const friendlyMessage = statusMessages[status];
    if (friendlyMessage) {
      // Log only the status code, not raw error which may contain sensitive data
      console.error(`[GRAFANA API] HTTP ${status}`);
      return friendlyMessage;
    }

    // For unknown errors, log status only and return generic message
    console.error(`[GRAFANA API] HTTP ${status}`);
    return `Request failed (HTTP ${status})`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 30000,
  ): Promise<ApiResponse<T>> {
    // Set up timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Filter undefined values from body to avoid API issues
      const cleanBody = body ? JSON.parse(JSON.stringify(body)) : undefined;

      // Only include Content-Type header when there's a body
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      };
      if (cleanBody) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: cleanBody ? JSON.stringify(cleanBody) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: this.sanitizeError(response.status, errorText),
        };
      }

      // Handle empty responses (some DELETE operations return no body)
      const contentLength = response.headers.get('content-length');

      // Only skip parsing if content-length explicitly says empty
      if (contentLength === '0') {
        return { success: true, data: undefined as T };
      }

      // Safely parse JSON - try to parse regardless of Content-Type header
      // since some servers omit it even for valid JSON responses
      const text = await response.text();
      if (!text || text.trim() === '') {
        return { success: true, data: undefined as T };
      }

      try {
        const data = JSON.parse(text) as T;
        return { success: true, data };
      } catch {
        // Don't log the raw text as it may contain sensitive data
        return {
          success: false,
          error: 'Invalid response from Grafana API',
        };
      }
    } catch (error) {
      // Handle timeout/abort errors
      if (error instanceof Error && error.name === 'AbortError') {
        console.error(`[GRAFANA API] Request timeout for ${method} ${path}`);
        return {
          success: false,
          error: 'Request timed out - Grafana may be slow or unreachable',
        };
      }

      // Log only the error type/message, not full stack which may leak info
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error(
        `[GRAFANA API] Request error for ${method} ${path}: ${errorMessage}`,
      );
      return {
        success: false,
        error: 'Failed to connect to Grafana - please check your configuration',
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ==================== Dashboard Operations ====================

  async listDashboards(
    query?: string,
    tag?: string,
    folderUid?: string,
  ): Promise<ApiResponse<unknown[]>> {
    const params = new URLSearchParams();
    if (query) params.append('query', query);
    if (tag) params.append('tag', tag);
    if (folderUid) params.append('folderUIDs', folderUid);
    params.append('type', 'dash-db');

    return this.request<unknown[]>('GET', `/api/search?${params.toString()}`);
  }

  async getDashboard(
    uid: string,
  ): Promise<ApiResponse<{ dashboard: Dashboard; meta: unknown }>> {
    return this.request<{ dashboard: Dashboard; meta: unknown }>(
      'GET',
      `/api/dashboards/uid/${encodeURIComponent(uid)}`,
    );
  }

  async createDashboard(
    dashboard: Dashboard,
    folderUid?: string,
    overwrite = false,
  ): Promise<ApiResponse<{ uid: string; url: string; status: string }>> {
    return this.request<{ uid: string; url: string; status: string }>(
      'POST',
      '/api/dashboards/db',
      {
        dashboard: {
          ...dashboard,
          id: null, // null for new dashboard
        },
        folderUid,
        overwrite,
        message: 'Created via MCP',
      },
    );
  }

  async updateDashboard(
    dashboard: Dashboard,
    folderUid?: string,
    overwrite = true,
  ): Promise<ApiResponse<{ uid: string; url: string; status: string }>> {
    return this.request<{ uid: string; url: string; status: string }>(
      'POST',
      '/api/dashboards/db',
      {
        dashboard,
        folderUid,
        overwrite,
        message: 'Updated via MCP',
      },
    );
  }

  async deleteDashboard(uid: string): Promise<ApiResponse<{ title: string }>> {
    return this.request<{ title: string }>(
      'DELETE',
      `/api/dashboards/uid/${encodeURIComponent(uid)}`,
    );
  }

  // ==================== Data Source Operations ====================

  async listDataSources(): Promise<ApiResponse<DataSource[]>> {
    return this.request<DataSource[]>('GET', '/api/datasources');
  }

  async getDataSource(uid: string): Promise<ApiResponse<DataSource>> {
    return this.request<DataSource>(
      'GET',
      `/api/datasources/uid/${encodeURIComponent(uid)}`,
    );
  }

  async getDataSourceByName(name: string): Promise<ApiResponse<DataSource>> {
    return this.request<DataSource>(
      'GET',
      `/api/datasources/name/${encodeURIComponent(name)}`,
    );
  }

  async createDataSource(
    dataSource: DataSource,
  ): Promise<ApiResponse<DataSource>> {
    return this.request<DataSource>('POST', '/api/datasources', dataSource);
  }

  async updateDataSource(
    uid: string,
    dataSource: DataSource,
  ): Promise<ApiResponse<DataSource>> {
    return this.request<DataSource>(
      'PUT',
      `/api/datasources/uid/${encodeURIComponent(uid)}`,
      dataSource,
    );
  }

  async deleteDataSource(
    uid: string,
  ): Promise<ApiResponse<{ message: string }>> {
    return this.request<{ message: string }>(
      'DELETE',
      `/api/datasources/uid/${encodeURIComponent(uid)}`,
    );
  }

  async testDataSource(
    uid: string,
  ): Promise<ApiResponse<{ status: string; message: string }>> {
    return this.request<{ status: string; message: string }>(
      'GET',
      `/api/datasources/uid/${encodeURIComponent(uid)}/health`,
    );
  }

  // ==================== Alert Rule Operations ====================

  async listAlertRules(): Promise<ApiResponse<AlertRule[]>> {
    return this.request<AlertRule[]>('GET', '/api/v1/provisioning/alert-rules');
  }

  async getAlertRule(uid: string): Promise<ApiResponse<AlertRule>> {
    return this.request<AlertRule>(
      'GET',
      `/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`,
    );
  }

  async createAlertRule(rule: AlertRule): Promise<ApiResponse<AlertRule>> {
    return this.request<AlertRule>(
      'POST',
      '/api/v1/provisioning/alert-rules',
      rule,
    );
  }

  async updateAlertRule(
    uid: string,
    rule: AlertRule,
  ): Promise<ApiResponse<AlertRule>> {
    return this.request<AlertRule>(
      'PUT',
      `/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`,
      rule,
    );
  }

  async deleteAlertRule(uid: string): Promise<ApiResponse<void>> {
    return this.request<void>(
      'DELETE',
      `/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`,
    );
  }

  // ==================== Contact Point Operations ====================

  async listContactPoints(): Promise<ApiResponse<ContactPoint[]>> {
    return this.request<ContactPoint[]>(
      'GET',
      '/api/v1/provisioning/contact-points',
    );
  }

  async createContactPoint(
    contactPoint: ContactPoint,
  ): Promise<ApiResponse<ContactPoint>> {
    return this.request<ContactPoint>(
      'POST',
      '/api/v1/provisioning/contact-points',
      contactPoint,
    );
  }

  async updateContactPoint(
    uid: string,
    contactPoint: ContactPoint,
  ): Promise<ApiResponse<void>> {
    return this.request<void>(
      'PUT',
      `/api/v1/provisioning/contact-points/${encodeURIComponent(uid)}`,
      contactPoint,
    );
  }

  async deleteContactPoint(uid: string): Promise<ApiResponse<void>> {
    return this.request<void>(
      'DELETE',
      `/api/v1/provisioning/contact-points/${encodeURIComponent(uid)}`,
    );
  }

  // ==================== Folder Operations ====================

  async listFolders(): Promise<ApiResponse<Folder[]>> {
    return this.request<Folder[]>('GET', '/api/folders');
  }

  async getFolder(uid: string): Promise<ApiResponse<Folder>> {
    return this.request<Folder>(
      'GET',
      `/api/folders/${encodeURIComponent(uid)}`,
    );
  }

  async createFolder(folder: Folder): Promise<ApiResponse<Folder>> {
    return this.request<Folder>('POST', '/api/folders', folder);
  }

  async updateFolder(
    uid: string,
    folder: { title: string },
  ): Promise<ApiResponse<Folder>> {
    return this.request<Folder>(
      'PUT',
      `/api/folders/${encodeURIComponent(uid)}`,
      folder,
    );
  }

  async deleteFolder(uid: string): Promise<ApiResponse<{ message: string }>> {
    return this.request<{ message: string }>(
      'DELETE',
      `/api/folders/${encodeURIComponent(uid)}`,
    );
  }

  // ==================== Annotation Operations ====================

  async listAnnotations(
    dashboardUid?: string,
    from?: number,
    to?: number,
    limit = 100,
    panelId?: number,
    tags?: string[],
  ): Promise<ApiResponse<unknown[]>> {
    const params = new URLSearchParams();
    if (dashboardUid) params.append('dashboardUID', dashboardUid);
    if (from !== undefined) params.append('from', from.toString());
    if (to !== undefined) params.append('to', to.toString());
    if (panelId !== undefined) params.append('panelId', panelId.toString());
    if (tags && tags.length > 0) {
      // Grafana accepts multiple tags params
      for (const tag of tags) {
        params.append('tags', tag);
      }
    }
    params.append('limit', limit.toString());

    return this.request<unknown[]>(
      'GET',
      `/api/annotations?${params.toString()}`,
    );
  }

  async createAnnotation(annotation: {
    dashboardUID?: string;
    panelId?: number;
    time: number;
    timeEnd?: number;
    tags?: string[];
    text: string;
  }): Promise<ApiResponse<{ id: number; message: string }>> {
    return this.request<{ id: number; message: string }>(
      'POST',
      '/api/annotations',
      annotation,
    );
  }

  async deleteAnnotation(
    id: number,
  ): Promise<ApiResponse<{ message: string }>> {
    return this.request<{ message: string }>(
      'DELETE',
      `/api/annotations/${id}`,
    );
  }

  // ==================== Query Operations ====================

  async queryMetrics(
    queries: {
      datasourceUid: string;
      expr: string;
      refId: string;
      instant?: boolean;
      range?: boolean;
    }[],
    from: number,
    to: number,
  ): Promise<ApiResponse<unknown>> {
    return this.request<unknown>('POST', '/api/ds/query', {
      queries,
      from: from.toString(),
      to: to.toString(),
    });
  }

  // ==================== Health Check ====================

  async healthCheck(): Promise<
    ApiResponse<{ commit: string; database: string; version: string }>
  > {
    return this.request<{ commit: string; database: string; version: string }>(
      'GET',
      '/api/health',
    );
  }

  async getCurrentUser(): Promise<
    ApiResponse<{ login: string; email: string; name: string; orgId: number }>
  > {
    return this.request<{
      login: string;
      email: string;
      name: string;
      orgId: number;
    }>('GET', '/api/user');
  }
}
