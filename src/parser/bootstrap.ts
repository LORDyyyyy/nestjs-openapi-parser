import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { VersioningConfig } from '../config/types';

export interface ResolvedVersioning {
  type: 'uri' | 'header' | 'media-type' | 'custom';
  /** URI version prefix (default `'v'`). */
  prefix: string;
  /** Default versions for routes without an explicit `@Version`, normalized to an array. */
  defaultVersion: string[];
}

export interface BootstrapInfo {
  globalPrefix?: string;
  versioning?: ResolvedVersioning;
}

const VERSIONING_TYPES: Record<string, ResolvedVersioning['type']> = {
  URI: 'uri',
  HEADER: 'header',
  MEDIA_TYPE: 'media-type',
  CUSTOM: 'custom',
};

/**
 * Statically read the NestJS bootstrap configuration from source — the
 * `app.setGlobalPrefix(...)` and `app.enableVersioning(...)` calls — so the
 * generator can mirror them without booting the app.
 *
 * Best-effort: calls whose arguments aren't literals are skipped (with a
 * warning — an explicit config field is the escape hatch).
 * Methods are matched by name only, so any `app`-like receiver works.
 * The first match of each kind wins.
 *
 * `sourceFiles` is already scoped to the project's rootDir with excludeSuffixes
 * applied (so `*.spec.ts`/`*.d.ts` are out), but `*.e2e-spec.ts` test apps and
 * the like can still slip through. To keep a test app's `setGlobalPrefix` from
 * beating `main.ts`, the file that calls `NestFactory.create(...)` is scanned
 * first; everything else is a fallback.
 */
export function detectBootstrap(sourceFiles: SourceFile[]): BootstrapInfo {
  const info: BootstrapInfo = {};

  const bootstrapFiles: SourceFile[] = [];
  const others: SourceFile[] = [];
  for (const sourceFile of sourceFiles) {
    (callsNestFactory(sourceFile) ? bootstrapFiles : others).push(sourceFile);
  }

  for (const sourceFile of [...bootstrapFiles, ...others]) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;

      const name = callee.getName();

      if (name === 'setGlobalPrefix' && info.globalPrefix === undefined) {
        const arg = call.getArguments()[0];
        if (arg && Node.isStringLiteral(arg)) {
          info.globalPrefix = arg.getLiteralValue();
        } else if (arg) {
          warnDynamic('setGlobalPrefix', arg);
        }
        // TODO: support `app.setGlobalPrefix('...', { exclude: ['/health', { path: 'robots.txt', method: RequestMethod.GET }] })`
      } else if (name === 'enableVersioning' && info.versioning === undefined) {
        const arg = call.getArguments()[0];
        if (arg && !Node.isObjectLiteralExpression(arg)) warnDynamic('enableVersioning', arg);
        info.versioning = readVersioning(arg);
      }
    }

    if (info.globalPrefix !== undefined && info.versioning !== undefined) break;
  }

  return info;
}

/** True when a source file calls `NestFactory.create(...)` */
function callsNestFactory(sourceFile: SourceFile): boolean {
  return sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const callee = call.getExpression();
    return (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === 'create' &&
      callee.getExpression().getText() === 'NestFactory'
    );
  });
}

function warnDynamic(method: string, arg: Node): void {
  console.warn(
    `[nestparser] app.${method}(...) argument "${arg.getText()}" isn't a static literal, ` +
      `so it was skipped. Set it explicitly in the parser config if it affects route URLs.`,
  );
}

/** Turn a resolved config back into the same shape the detector produces. */
export function normalizeVersioning(config: VersioningConfig): ResolvedVersioning {
  return {
    type: config.type ?? 'uri',
    prefix: config.prefix ?? 'v',
    defaultVersion: toArray(config.defaultVersion),
  };
}

function readVersioning(arg: Node | undefined): ResolvedVersioning {
  // `enableVersioning()` with no options defaults to URI versioning.
  const result: ResolvedVersioning = { type: 'uri', prefix: 'v', defaultVersion: [] };

  if (!arg || !Node.isObjectLiteralExpression(arg)) return result;

  const type = arg.getProperty('type');

  if (type && Node.isPropertyAssignment(type)) {
    const init = type.getInitializer();

    // `VersioningType.URI` reads the member name; fall back to a plain string.
    if (init && Node.isPropertyAccessExpression(init)) {
      result.type = VERSIONING_TYPES[init.getName()] ?? result.type;
    } else if (init && Node.isStringLiteral(init)) {
      result.type = VERSIONING_TYPES[init.getLiteralValue().toUpperCase()] ?? result.type;
    }
  }

  const prefix = arg.getProperty('prefix');
  if (prefix && Node.isPropertyAssignment(prefix)) {
    const init = prefix.getInitializer();

    // `prefix: false` disables the prefix in NestJS.
    if (init && Node.isStringLiteral(init)) result.prefix = init.getLiteralValue();
    else if (init && init.getText() === 'false') result.prefix = '';
  }

  const def = arg.getProperty('defaultVersion');
  if (def && Node.isPropertyAssignment(def)) {
    const init = def.getInitializer();
    if (init) result.defaultVersion = readVersionValues(init);
  }

  return result;
}

/**
 * Read a NestJS version value node — a string literal, the `VERSION_NEUTRAL`
 * identifier (→ `''`, meaning no version segment), or an array mixing both — into
 * a deduped version list. Non-literal / dynamic entries are dropped (best-effort).
 */
export function readVersionValues(node: Node): string[] {
  const toValue = (n: Node): string | undefined => {
    if (Node.isStringLiteral(n)) return n.getLiteralValue();
    if (Node.isIdentifier(n) && n.getText() === 'VERSION_NEUTRAL') return '';
    return undefined;
  };

  const nodes = Node.isArrayLiteralExpression(node) ? node.getElements() : [node];
  return [...new Set(nodes.map(toValue).filter((v): v is string => v !== undefined))];
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
