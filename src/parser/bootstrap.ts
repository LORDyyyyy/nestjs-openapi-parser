import { Node, Project, SyntaxKind } from 'ts-morph';
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
 * Best-effort: calls whose arguments aren't literals are skipped
 * (an explicit config field is the escape hatch).
 * Methods are matched by name only, so any `app`-like receiver works.
 * The first match of each kind wins.
 */
export function detectBootstrap(project: Project): BootstrapInfo {
  const info: BootstrapInfo = {};

  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isInNodeModules()) continue;

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;

      const name = callee.getName();

      if (name === 'setGlobalPrefix' && info.globalPrefix === undefined) {
        const arg = call.getArguments()[0];
        if (arg && Node.isStringLiteral(arg)) {
          info.globalPrefix = arg.getLiteralValue();
        }
        // TODO: support `app.setGlobalPrefix('...', { exclude: ['/health', { path: 'robots.txt', method: RequestMethod.GET }] })`
      } else if (name === 'enableVersioning' && info.versioning === undefined) {
        info.versioning = readVersioning(call.getArguments()[0]);
      }
    }

    if (info.globalPrefix !== undefined && info.versioning !== undefined) break;
  }

  return info;
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

    if (init && Node.isStringLiteral(init)) {
      result.defaultVersion = [init.getLiteralValue()];
    } else if (init && Node.isArrayLiteralExpression(init)) {
      result.defaultVersion = init
        .getElements()
        .filter(Node.isStringLiteral)
        .map((el) => el.getLiteralValue());
    }
  }

  return result;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
