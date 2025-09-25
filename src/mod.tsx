import * as denoPath from "jsr:@std/path";

import { Context, LogLevel } from "macromania";
import { Path, type Pathish } from "@aljoscha-meyer/simple-fs-abstraction";

/**
 * Specifies which asset transformations to apply. Roughly speaking, the `Pathish`s specify the input file to the transformation pipeline, and Pathishs which point to directories are recursively applied to all contents, unless there exists a more specific pair specifying a transformation for that content.
 */
export type Transformations = Array<
  [Pathish, TransformationPipeline] | [
    Pathish,
    TransformationPipeline,
    LogLevel,
  ]
>;

type NormalisedTransformations = Array<TransformationSpec>;

type TransformationSpec = {
  path: Path;
  pipeline: Array<Transformation>;
  unused: LogLevel;
};

/**
 * Describes how to convert a single input asset file (always a leaf file, never a directory) into (at most) a single output file.
 */
export interface Transformation {
  /**
   * Performs the asset transformation, and return where it placed the output.
   *
   * Both the `inputPath` and the returned string are platform-dependent absolute paths. No `macromania_fs` usage here, because the most interesting transformations (say, compiling source code) call third-party tooling which is not macromania-aware.
   *
   * If this function returns `null`, then the asset is *not* moved to the output directory. If there are further [`TransformationPipieline`] steps remaining, macro evaluation halts with an error.
   */
  runTransformation: (
    ctx: Context,
    inputPath: string,
  ) => Promise<string | null>;
}

/**
 * A series of transformations, to be applied sequentially. A non-array Transformation is equivalent to the singleton array containing that Transformation.
 */
export type TransformationPipeline = Transformation | Array<Transformation>;

/**
 * The asset transformation which simply ignores the asset. The asset will *not* be copied into the output directory.
 */
export const ASSET_IGNORE: Transformation = {
  runTransformation: (
    _ctx: Context,
    _inputPath: string,
  ) => {
    return Promise.resolve(null);
  },
};

/**
 * The asset transformation which simply copies the asset to the output directory.
 */
export const ASSET_COPY: Transformation = {
  runTransformation: (
    _ctx: Context,
    inputPath: string,
  ) => {
    return Promise.resolve(inputPath);
  },
};

/**
 * Parses and normalises a Pathish and checks that is suitable for usage with macromania_assets (it must be absolute).
 */
function parseAssetPathish(ctx: Context, p: Pathish): Path | null {
  try {
    const path = Path.fromPathish(p);

    if (path.getParentSteps() > 0) {
      ctx.error(
        `An asset path must be an absolute path (starting with ${
          ctx.fmtCode("/")
        }); the assets input directory becomes the root for these paths.`,
      );
      ctx.error(`Offending path: ${p}`);
      ctx.currentError();
      ctx.halt();
      return null;
    }

    return path;
  } catch (parseError) {
    ctx.error(
      `Could not parse a given path:`,
    );
    ctx.error(`${p}`);
    ctx.error(parseError);
    ctx.currentError();
    ctx.halt();
    return null;
  }
}

type RegistrationInformationCollector = {
  /**
   * Remove from this set every asset Path.toString() for which we found a directory or leaf file.
   */
  remainingUnusedTransformations: Set<string>;
  /**
   * Add to this map keyed by Path.toString() for every leaf file we transformed successfully (i.e., the pipeline did not return null).
   */
  successfulTransformations: Map<string, ProcessedTransformation>;
};

/**
 * Returns `true` if things worked, `false` if evaluation had to halt.
 */
async function runTransformations(
  ctx: Context,
  transformations: NormalisedTransformations,
  tmpDir: string,
  unusedTransformationLoggingLevel: LogLevel,
): Promise<boolean> {
  const trie = buildTransformationsTrie(transformations);

  if (trie === null) {
    return false;
  }

  // Create a set of all explicitly specified transformations.
  // This set is passed to the funciton running the transformations, and in running them,
  // all paths which were found in the filesystem are removed.
  // We later check if all of them were removed.
  const remainingUnusedTransformations: Set<string> = new Set();

  for (const { path } of transformations) {
    remainingUnusedTransformations.add(
      // Parsing failures already caught when creating the trie.
      path.toString(),
    );
  }

  const collector = {
    remainingUnusedTransformations,
    successfulTransformations: new Map(),
  };

  if (
    !await trie.runTransformationsOnKnownDirectory(
      ctx,
      Path.absolute([]),
      tmpDir,
      collector,
    )
  ) {
    return false;
  }

  // Log warnings if there are unused transformations.
  const plural = remainingUnusedTransformations.size > 1;
  if (remainingUnusedTransformations.size > 0) {
    ctx.log(
      unusedTransformationLoggingLevel,
      `Specified ${plural ? "some" : "an"} asset transformation${
        plural ? "s" : ""
      } for which the asset input directory did not contain any file${
        plural ? "s" : ""
      } or director${plural ? "ies" : "y"}:`,
    );
  }
  ctx.loggingGroup(() => {
    for (const unused of remainingUnusedTransformations.entries()) {
      ctx.log(unusedTransformationLoggingLevel, unused);
    }
  });

  if (remainingUnusedTransformations.size > 0) {
    ctx.currentLog(unusedTransformationLoggingLevel);
    ctx.logEmptyLine(unusedTransformationLoggingLevel);
    ctx.log(
      unusedTransformationLoggingLevel,
      `To remove the preceding warning${plural ? "s" : ""} about ${
        plural ? "" : "an"
      } unused asset transformation${plural ? "s" : ""}, set the ${
        ctx.fmtCode("unusedTransformations")
      } prop of the ${ctx.fmtCode("Assets")} macro to, e.g., ${
        ctx.fmtCode("ignore")
      }.`,
    );

    if (unusedTransformationLoggingLevel === "error") {
      ctx.halt();
      return Promise.resolve(false);
    }
  }

  return Promise.resolve(true);
}

/**
 * Build up a trie describing the Transformations. Returns its root, or `null` if an error occured (for example, an invalid Pathish).
 */
function buildTransformationsTrie(
  transformations: NormalisedTransformations,
): TrieNode | null {
  const defaultPipeline = [ASSET_COPY];
  const defaultUnused = "warn";
  const trieRoot = new TrieNode(defaultPipeline, defaultUnused);

  // Sort by component count, keeping the old ordering in case of ties (tiebreaker is pretty arbitrary, the important part is to process prefixes before their extensions later).
  transformations.sort(({ path: p1 }, { path: p2 }) => {
    if (p1.getComponentCount() !== p2.getComponentCount()) {
      return p1.getComponentCount() - p2.getComponentCount();
    } else {
      return -1;
    }
  });

  for (const { path, pipeline, unused } of transformations) {
    const componentCount = path.getComponentCount();

    if (componentCount === 0) {
      trieRoot.pipeline = pipeline;
    } else {
      let node = trieRoot;
      let prevPipeline = trieRoot.pipeline;
      let prevUnused = trieRoot.unused;

      for (let i = 0; i < componentCount; i++) {
        node = node.getOrCreateChild(
          path.getIthComponent(i)!,
          i === componentCount - 1 ? pipeline : prevPipeline,
          i === componentCount - 1 ? unused : prevUnused,
        );

        prevPipeline = node.pipeline;
        prevUnused = node.unused;
      }
    }
  }

  return trieRoot;
}

/**
 * Represents a directory in the trie of asset paths given in the Transformations.
 */
class TrieNode {
  /**
   * The pipeline to apply to everything in this directory (unless a more specific trie node overrides that pipeline).
   */
  pipeline: Array<Transformation>;
  unused: LogLevel;
  /**
   * Keys are single path components.
   */
  children: Map<string, TrieNode>;

  constructor(pipeline: Array<Transformation>, unused: LogLevel) {
    this.pipeline = pipeline;
    this.unused = unused;
    this.children = new Map();
  }

  /**
   * Returns the child of the given path component, or creates it if necessary. If a new node is created, its pipeline is set to `pipeline`.
   */
  getOrCreateChild(
    component: string,
    pipeline: Array<Transformation>,
    unused: LogLevel,
  ): TrieNode {
    const child = this.children.get(component);

    if (child === undefined) {
      const newChild = new TrieNode(
        pipeline,
        unused,
      );
      this.children.set(component, newChild);
      return newChild;
    } else {
      return child;
    }
  }

  /**
   * @param assetPath Path, absolute, rooted at asset dir
   * @param currentPath  absolute, platform-specific path
   */
  async runTransformationsOnKnownDirectory(
    ctx: Context,
    assetPath: Path,
    currentPath: string,
    collector: RegistrationInformationCollector,
  ): Promise<boolean> {
    collector.remainingUnusedTransformations.delete(assetPath.toString());

    try {
      for await (const dirEntry of Deno.readDir(currentPath)) {
        const nativePath = denoPath.join(currentPath, dirEntry.name);
        const newAssetPath = assetPath.concat(dirEntry.name);

        const nodeForEntry = this.children.get(dirEntry.name);

        if (nodeForEntry === undefined) {
          if (dirEntry.isDirectory) {
            if (
              !await runTransformationsOnUnknownDirectory(
                ctx,
                newAssetPath,
                nativePath,
                this.pipeline,
                this.unused,
                collector,
              )
            ) {
              return Promise.resolve(false);
            }
          } else if (dirEntry.isFile) {
            if (
              !await applyPipelineToLeafFile(
                ctx,
                newAssetPath,
                this.pipeline,
                this.unused,
                nativePath,
                collector,
              )
            ) {
              return Promise.resolve(false);
            }
          } else {
            ctx.error(
              `Assets must not be symlinks (we would accept a pull request changing this, though)`,
            );
            ctx.error(`Path: ${ctx.fmtFilePath(currentPath)}`);
            ctx.currentError();
            ctx.halt();
          }
        } else {
          if (dirEntry.isDirectory) {
            if (
              !await nodeForEntry.runTransformationsOnKnownDirectory(
                ctx,
                newAssetPath,
                nativePath,
                collector,
              )
            ) {
              return Promise.resolve(false);
            }
          } else if (dirEntry.isFile) {
            if (
              !await applyPipelineToLeafFile(
                ctx,
                newAssetPath,
                this.pipeline,
                this.unused,
                nativePath,
                collector,
              )
            ) {
              return Promise.resolve(false);
            }
          } else {
            ctx.error(
              `Assets must not be symlinks (we would accept a pull request changing this, though)`,
            );
            ctx.error(`Path: ${ctx.fmtFilePath(currentPath)}`);
            ctx.currentError();
            ctx.halt();
          }
        }
      }
    } catch (err) {
      ctx.error(
        `Failed to read contents of a temporary directory while trying to process assets:`,
      );
      ctx.error(`Path: ${ctx.fmtFilePath(currentPath)}`);
      ctx.error(err);
      ctx.currentError();
      ctx.halt();
      return Promise.resolve(false);
    }

    return Promise.resolve(true);
  }
}

/**
 * @param assetPath Path, absolute, rooted at asset dir
 * @param currentPath  absolute, platform-specific path
 */
async function runTransformationsOnUnknownDirectory(
  ctx: Context,
  assetPath: Path,
  currentPath: string,
  pipeline: Array<Transformation>,
  unused: LogLevel,
  collector: RegistrationInformationCollector,
): Promise<boolean> {
  try {
    for await (const dirEntry of Deno.readDir(currentPath)) {
      const nativePath = denoPath.join(currentPath, dirEntry.name);
      const newAssetPath = assetPath.concat(dirEntry.name);

      if (dirEntry.isDirectory) {
        if (
          !await runTransformationsOnUnknownDirectory(
            ctx,
            newAssetPath,
            nativePath,
            pipeline,
            unused,
            collector,
          )
        ) {
          return Promise.resolve(false);
        }
      } else if (dirEntry.isFile) {
        if (
          !await applyPipelineToLeafFile(
            ctx,
            newAssetPath,
            pipeline,
            unused,
            nativePath,
            collector,
          )
        ) {
          return Promise.resolve(false);
        }
      } else {
        ctx.error(
          `Assets must not be symlinks (we would accept a pull request changing this, though)`,
        );
        ctx.error(`Path: ${ctx.fmtFilePath(currentPath)}`);
        ctx.currentError();
        ctx.halt();
      }
    }
  } catch (err) {
    ctx.error(
      `Failed to read contents of a temporary directory while trying to process assets:`,
    );
    ctx.error(`Path: ${ctx.fmtFilePath(currentPath)}`);
    ctx.error(err);
    ctx.currentError();
    ctx.halt();
    return Promise.resolve(false);
  }

  return Promise.resolve(true);
}

async function applyPipelineToLeafFile(
  ctx: Context,
  assetPath: Path,
  pipeline: Array<Transformation>,
  unused: LogLevel,
  path_: string,
  collector: RegistrationInformationCollector,
): Promise<boolean> {
  const assetPathToString = assetPath.toString();
  collector.remainingUnusedTransformations.delete(assetPathToString);

  let path: string | null = path_;

  for (const transformation of pipeline) {
    try {
      path = await transformation.runTransformation(ctx, path!);

      if (path === null) {
        return Promise.resolve(true);
      }
    } catch (err) {
      ctx.error(`Failed to transform an asset:`);
      ctx.error(err);
      ctx.currentError();
      ctx.halt();
      return Promise.resolve(false);
    }
  }

  collector.successfulTransformations.set(assetPathToString, {
    unused: unused,
    tempLocation: path!,
    // Setting this to a proper value elsewhere, when copying from the temp dir to the output dir.
    outputPath: Path.absolute([]),
  });

  return Promise.resolve(true);
}

type ProcessedTransformation = {
  unused: LogLevel;
  /**
   * The absolute, platform-specific path in the temp dir where the output was placed by the pipeline.
   */
  tempLocation: string;
  /**
   * The location in the simple_fs where the transformed asset is to be placed.
   */
  outputPath: Path;
};
