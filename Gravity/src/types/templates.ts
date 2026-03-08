export interface TemplateSummary {
  id: string;
  name: string;
  path: string;
  updatedAt: number;
}

export interface TemplateContent extends TemplateSummary {
  body: string;
  subject?: string;
  tags?: string[];
}
