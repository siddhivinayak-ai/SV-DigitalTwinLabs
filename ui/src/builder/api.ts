// Plant Builder REST calls (docs/V0.3-PlantBuilder.md §4) on top of the shared Api helper.
import { Api, ApiError } from '../net/api';
import type {
  Layout, LayoutSummary, PlantModel, SaveLayoutRequest, SnapshotData, TemplateInfo, ValidationIssue, ValidationResult,
} from '../net/contracts';

export class BuilderApi {
  constructor(private readonly api = new Api()) {}

  validate(p: PlantModel): Promise<ValidationResult> { return this.api.request<ValidationResult>('POST', '/plant/validate', p, 15_000); }

  /** PUT /api/plant. On 422 throws ApplyRejected with the issues from the problem body. */
  async apply(p: PlantModel): Promise<SnapshotData> {
    try {
      return await this.api.request<SnapshotData>('PUT', '/plant', p, 30_000);
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const issues = (e.problem as { issues?: ValidationIssue[] } | undefined)?.issues ?? [];
        throw new ApplyRejected(e.message, issues);
      }
      throw e;
    }
  }

  templates(): Promise<TemplateInfo[]> { return this.api.get<TemplateInfo[]>('/templates'); }
  template(id: string): Promise<PlantModel> { return this.api.get<PlantModel>(`/templates/${encodeURIComponent(id)}`); }

  layouts(): Promise<LayoutSummary[]> { return this.api.get<LayoutSummary[]>('/layouts'); }
  layout(id: string): Promise<Layout> { return this.api.get<Layout>(`/layouts/${encodeURIComponent(id)}`); }
  createLayout(req: SaveLayoutRequest): Promise<Layout> { return this.api.request<Layout>('POST', '/layouts', req); }
  updateLayout(id: string, req: SaveLayoutRequest): Promise<Layout> { return this.api.request<Layout>('PUT', `/layouts/${encodeURIComponent(id)}`, req); }
  deleteLayout(id: string): Promise<void> { return this.api.request<void>('DELETE', `/layouts/${encodeURIComponent(id)}`); }
}

export class ApplyRejected extends Error {
  constructor(message: string, readonly issues: ValidationIssue[]) {
    super(message);
    this.name = 'ApplyRejected';
  }
}

/** True when an error means "no server here" (network failure, 404 from a static host, 5xx gateway). */
export function isUnreachable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.status === 404 || e.status === 502 || e.status === 503 || e.status === 504);
}

export function errorText(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}
