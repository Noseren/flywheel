import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type PromptAssetSource = "project" | "configured" | "builtin";

export interface PromptRequest {
  kind: "prompt-asset";
  assetId: string;
  variables?: Record<string, unknown | PromptRequest>;
}

export interface PromptAssetUse {
  id: string;
  source: PromptAssetSource;
  path: string;
  templateSha256: string;
  renderedSha256: string;
}

export interface ResolvedPrompt {
  text: string;
  assets: PromptAssetUse[];
}

export interface PromptAssetInspection {
  id: string;
  source: PromptAssetSource;
  path: string;
  template: string;
  templateSha256: string;
}

export function promptAsset(
  assetId: string,
  variables: Record<string, unknown | PromptRequest> = {},
): PromptRequest {
  return { kind: "prompt-asset", assetId, variables };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPromptRequest(value: unknown): value is PromptRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === "prompt-asset"
    && typeof (value as { assetId?: unknown }).assetId === "string";
}

function assetPath(root: string, assetId: string): string {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(assetId)) {
    throw new Error(`Invalid prompt asset id: ${assetId}`);
  }
  return path.join(root, `${assetId.replaceAll(".", path.sep)}.md`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function markdownFiles(root: string): Promise<string[]> {
  if (!await exists(root)) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("._"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Resolve auditable Prompt assets with project overrides taking precedence over built-ins. */
export class PromptAssetStore {
  readonly projectRoot?: string;
  readonly configuredRoot?: string;
  readonly builtinRoot: string;

  constructor(options: {
    projectRoot?: string;
    configuredRoot?: string;
    builtinRoot?: string;
  } = {}) {
    this.projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : undefined;
    this.configuredRoot = options.configuredRoot ? path.resolve(options.configuredRoot) : undefined;
    this.builtinRoot = path.resolve(
      options.builtinRoot ?? path.join(import.meta.dirname, "..", "..", "..", "system-assets", "prompts"),
    );
  }

  private roots(): Array<{ source: PromptAssetSource; root: string }> {
    return [
      ...(this.projectRoot ? [{
        source: "project" as const,
        root: path.join(this.projectRoot, ".flywheel", "system-assets", "prompts"),
      }] : []),
      ...(this.configuredRoot ? [{ source: "configured" as const, root: this.configuredRoot }] : []),
      { source: "builtin" as const, root: this.builtinRoot },
    ];
  }

  async inspect(assetId: string): Promise<PromptAssetInspection> {
    for (const candidate of this.roots()) {
      const file = assetPath(candidate.root, assetId);
      if (!await exists(file)) continue;
      const template = await readFile(file, "utf8");
      return {
        id: assetId,
        source: candidate.source,
        path: file,
        template,
        templateSha256: sha256(template),
      };
    }
    throw new Error(`Prompt asset not found: ${assetId}`);
  }

  async resolve(request: PromptRequest): Promise<ResolvedPrompt> {
    return await this.resolveNested(request, []);
  }

  private async resolveNested(request: PromptRequest, stack: string[]): Promise<ResolvedPrompt> {
    if (stack.includes(request.assetId)) {
      throw new Error(`Recursive prompt asset reference: ${[...stack, request.assetId].join(" -> ")}`);
    }
    const inspected = await this.inspect(request.assetId);
    const variables = request.variables ?? {};
    const nestedAssets: PromptAssetUse[] = [];
    const renderedValues = new Map<string, string>();
    for (const [key, value] of Object.entries(variables)) {
      if (isPromptRequest(value)) {
        const nested = await this.resolveNested(value, [...stack, request.assetId]);
        renderedValues.set(key, nested.text);
        nestedAssets.push(...nested.assets);
      } else if (typeof value === "string") {
        renderedValues.set(key, value);
      } else if (value === undefined) {
        renderedValues.set(key, "");
      } else {
        renderedValues.set(key, JSON.stringify(value));
      }
    }

    const required = new Set(
      [...inspected.template.matchAll(/{{([a-zA-Z0-9_]+)}}/g)].map((match) => match[1]),
    );
    for (const key of required) {
      if (!renderedValues.has(key)) {
        throw new Error(`Prompt asset ${request.assetId} is missing variable: ${key}`);
      }
    }
    const text = inspected.template.replace(/{{([a-zA-Z0-9_]+)}}/g, (_match, key: string) => renderedValues.get(key)!);
    const current: PromptAssetUse = {
      id: request.assetId,
      source: inspected.source,
      path: inspected.path,
      templateSha256: inspected.templateSha256,
      renderedSha256: sha256(text),
    };
    return { text, assets: [current, ...nestedAssets] };
  }

  async list(): Promise<PromptAssetInspection[]> {
    const ids = new Set<string>();
    for (const candidate of this.roots()) {
      for (const file of await markdownFiles(candidate.root)) {
        ids.add(path.relative(candidate.root, file).replace(/\.md$/, "").split(path.sep).join("."));
      }
    }
    return await Promise.all([...ids].sort().map(async (id) => await this.inspect(id)));
  }

  async validateAll(): Promise<void> {
    for (const asset of await this.list()) {
      if (!asset.template.trim()) throw new Error(`Prompt asset ${asset.id} is empty`);
      if (/{{[a-zA-Z0-9_]+}(?!})/.test(asset.template)) {
        throw new Error(`Prompt asset ${asset.id} has a malformed placeholder`);
      }
    }
  }

  async materializeOverride(assetId: string): Promise<string> {
    if (!this.projectRoot) throw new Error("A project root is required to create a prompt override");
    const source = await this.inspect(assetId);
    const destination = assetPath(
      path.join(this.projectRoot, ".flywheel", "system-assets", "prompts"),
      assetId,
    );
    if (await exists(destination)) return destination;
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source.path, destination, { errorOnExist: true });
    return destination;
  }
}
